import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LauncherFlag } from "@prifly/extension-api";
import { Accounts } from "../accounts";
import { AlarmWatch, parseAlarms } from "../alarms";
import { keyOf, launchOf } from "../launch";
import { type Canned, fakeAws, xml, xmlError } from "./fake-aws";

let folder = "";
let clock = 0;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aws-alarms-"));
  clock = Date.parse("2026-10-11T08:00:00Z");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const REGIONS = xml(
  "<DescribeRegionsResponse><regionInfo>" +
    ["eu-north-1", "us-east-1", "ap-south-1"]
      .map((name) => `<item><regionName>${name}</regionName></item>`)
      .join("") +
    "</regionInfo></DescribeRegionsResponse>",
);

const alarm = (name: string, metric: string) =>
  `<member><AlarmName>${name}</AlarmName><MetricName>${metric}</MetricName><Namespace>AWS/RDS</Namespace>` +
  `<StateValue>ALARM</StateValue><StateUpdatedTimestamp>2026-10-11T07:41:00Z</StateUpdatedTimestamp>` +
  `<StateReason>Threshold &amp; more</StateReason><Dimensions><member><Name>DBInstanceIdentifier</Name><Value>odi</Value></member></Dimensions></member>`;

/** DescribeAlarms: alarms only in eu-north-1; the sweep's single-record probe sees them there too. */
const alarmsByRegion =
  (inAlarm: Record<string, string[]>) =>
  (request: Request, body: string): Response => {
    const region = new URL(request.url).hostname.split(".")[1] ?? "";
    const names = inAlarm[region] ?? [];
    const asked = new URLSearchParams(body);
    const list = asked.get("StateValue") === "ALARM" ? names : names.length > 0 ? ["any"] : [];
    return xml(
      `<DescribeAlarmsResponse><DescribeAlarmsResult><CompositeAlarms/><MetricAlarms>${list.map((name) => alarm(name, "FreeStorageSpace")).join("")}</MetricAlarms></DescribeAlarmsResult></DescribeAlarmsResponse>`,
    );
  };

function setup(table: Record<string, Canned>) {
  const fake = fakeAws({ "ec2:DescribeRegions": REGIONS, ...table });
  const accounts = new Accounts(
    () => fake.connections,
    () => clock,
  );
  const flags: (LauncherFlag | null)[] = [];
  const watch = new AlarmWatch(folder, accounts, (flag) => flags.push(flag));
  const alarmCalls = () => fake.sent.filter((each) => each.service === "monitoring");
  return { fake, watch, flags, alarmCalls };
}

test("parseAlarms reads metric alarms, decodes entities and finds the next token", () => {
  const parsed = parseAlarms(
    `<r><MetricAlarms>${alarm("rds-low", "FreeStorageSpace")}</MetricAlarms><CompositeAlarms><member><AlarmName>combo</AlarmName></member></CompositeAlarms><NextToken>t&amp;1</NextToken></r>`,
  );
  expect(parsed.next).toBe("t&1");
  expect(parsed.alarms).toMatchObject([
    {
      name: "rds-low",
      metric: "FreeStorageSpace",
      namespace: "AWS/RDS",
      reason: "Threshold & more",
      composite: false,
    },
    { name: "combo", composite: true },
  ]);
});

test("the daily sweep finds the regions with alarms, then polls only those", async () => {
  const { watch, alarmCalls } = setup({
    "cloudwatch:DescribeAlarms": alarmsByRegion({
      "eu-north-1": ["odi-prod-5xx-rate", "rds-free-storage-low"],
    }),
  });
  await watch.poll();
  // The sweep: DescribeRegions, one DescribeAlarms in each of the three regions, then the ALARM read in the one with alarms.
  expect(alarmCalls().map((each) => each.region)).toEqual([
    "eu-north-1",
    "us-east-1",
    "ap-south-1",
    "eu-north-1",
  ]);
  expect(watch.regionsOf("aws-1")).toEqual(["eu-north-1"]);
  expect(watch.alarms().map((each) => each.name)).toEqual([
    "odi-prod-5xx-rate",
    "rds-free-storage-low",
  ]);
  expect(watch.alarms()[0]).toMatchObject({
    account: "aws-1",
    accountName: "artemis-prod",
    region: "eu-north-1",
    metric: "FreeStorageSpace",
  });
});

test("the five-minute poll asks only the remembered regions and only for ALARM", async () => {
  const { watch, fake, alarmCalls } = setup({
    "cloudwatch:DescribeAlarms": alarmsByRegion({ "eu-north-1": ["a"] }),
  });
  await watch.poll();
  const before = fake.sent.length;
  clock += 5 * 60_000;
  await watch.poll();
  const since = fake.sent.slice(before);
  expect(since.map((each) => `${each.service}:${each.region}`)).toEqual(["monitoring:eu-north-1"]);
  expect(new URLSearchParams(since[0]?.body).get("StateValue")).toBe("ALARM");
  expect(fake.sent.filter((each) => each.service === "ec2")).toHaveLength(1);
  expect(alarmCalls()).toHaveLength(5);
});

test("an alarm deleted while in ALARM disappears when the next sweep drops its region", async () => {
  let inAlarm: Record<string, string[]> = { "eu-north-1": ["a"] };
  const { watch, flags } = setup({
    "cloudwatch:DescribeAlarms": (request, body) => alarmsByRegion(inAlarm)(request, body),
  });
  await watch.poll();
  expect(watch.alarms()).toHaveLength(1);
  inAlarm = {};
  clock = Date.parse("2026-10-12T08:00:00Z");
  await watch.poll();
  expect(watch.alarms()).toEqual([]);
  expect(flags.at(-1)).toBeNull();
});

test("a key that needs signing in loses its listed alarms and the glow", async () => {
  const { watch, fake, flags } = setup({
    "cloudwatch:DescribeAlarms": alarmsByRegion({ "eu-north-1": ["a"] }),
  });
  await watch.poll();
  expect(flags.at(-1)).not.toBeNull();
  fake.endpoint.revoke("aws-1");
  await watch.poll();
  expect(watch.alarms()).toEqual([]);
  expect(flags.at(-1)).toBeNull();
});

test("a new day sweeps again", async () => {
  const { watch, fake } = setup({
    "cloudwatch:DescribeAlarms": alarmsByRegion({ "eu-north-1": ["a"] }),
  });
  await watch.poll();
  clock = Date.parse("2026-10-12T08:00:00Z");
  await watch.poll();
  expect(fake.sent.filter((each) => each.service === "ec2")).toHaveLength(2);
});

test("the launcher glows while an alarm is in ALARM and goes out when none is", async () => {
  let inAlarm: Record<string, string[]> = { "eu-north-1": ["a", "b"] };
  const { watch, flags } = setup({
    "cloudwatch:DescribeAlarms": (request, body) => alarmsByRegion(inAlarm)(request, body),
  });
  await watch.poll();
  expect(flags).toEqual([{ tone: "critical", hint: "2 CloudWatch alarms in ALARM" }]);
  inAlarm = { "eu-north-1": [] };
  await watch.poll();
  expect(flags.at(-1)).toBeNull();
  expect(watch.alarms()).toEqual([]);
});

test("an account whose alarms cannot be read shows none, and a signed-out key is skipped with a reason", async () => {
  const { watch, fake, flags } = setup({
    "cloudwatch:DescribeAlarms": xmlError("AccessDenied", "no cloudwatch:DescribeAlarms"),
  });
  await watch.poll();
  expect(watch.regionsOf("aws-1")).toEqual([]);
  expect(watch.alarms()).toEqual([]);
  expect(flags).toEqual([null]);
  fake.endpoint.revoke("aws-1");
  await watch.poll();
  expect(watch.problemOf("aws-1")).toContain("signing in again");
});

test("a picked alarm starts a session naming the alarm, account, region and metric", async () => {
  const { watch } = setup({
    "cloudwatch:DescribeAlarms": alarmsByRegion({ "eu-north-1": ["rds-free-storage-low"] }),
  });
  await watch.poll();
  const picked = watch.alarms()[0];
  const launch = launchOf(watch.alarms(), picked === undefined ? "" : keyOf(picked));
  expect(launch.prompt).toContain("rds-free-storage-low");
  expect(launch.prompt).toContain("artemis-prod");
  expect(launch.prompt).toContain("eu-north-1");
  expect(launch.prompt).toContain("AWS/RDS FreeStorageSpace");
  expect(launch.prompt).toContain("aws_call");
  expect(launch.prompt).toContain("GetMetricData");
  expect(launch.prompt).toContain("FilterLogEvents");
  expect(launchOf(watch.alarms(), "gone|x|y")).toMatchObject({ prompt: "" });
});
