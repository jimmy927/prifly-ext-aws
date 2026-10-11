import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionModule, LaunchBoard } from "@prifly/extension-api";
import { Accounts } from "../accounts";
import { AlarmWatch } from "../alarms";
import { CallLog } from "../calls";
import { CostStore } from "../cost";
import * as extension from "../index";
import { type BoardDeps, board, SIGN_IN } from "../launch";
import { fakeApi } from "./fake-api";
import {
  type Canned,
  fakeAws,
  IDENTITY,
  json,
  jsonError,
  KEY,
  SECOND,
  xml,
  xmlError,
} from "./fake-aws";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

let folder = "";
let clock = 0;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aws-board-"));
  clock = Date.parse("2026-10-11T12:00:00Z");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const KEYS = xml(
  "<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata>" +
    "<member><AccessKeyId>AKIAOLDOLDOLDOLD7QX2</AccessKeyId><Status>Active</Status><CreateDate>2026-03-12T10:00:00Z</CreateDate></member>" +
    "<member><AccessKeyId>AKIANEWNEWNEWNEWM3D9</AccessKeyId><Status>Active</Status><CreateDate>2026-08-31T10:00:00Z</CreateDate></member>" +
    "<member><AccessKeyId>AKIAGONEGONEGONEGONE</AccessKeyId><Status>Inactive</Status><CreateDate>2025-01-01T10:00:00Z</CreateDate></member>" +
    "</AccessKeyMetadata></ListAccessKeysResult></ListAccessKeysResponse>",
);
const lastUsed: Canned = (_request, body) => {
  const id = new URLSearchParams(body).get("AccessKeyId");
  const when = id === "AKIAOLDOLDOLDOLD7QX2" ? "2026-10-11T11:58:00Z" : "2026-09-01T10:00:00Z";
  return xml(
    `<R><GetAccessKeyLastUsedResult><AccessKeyLastUsed><LastUsedDate>${when}</LastUsedDate></AccessKeyLastUsed></GetAccessKeyLastUsedResult></R>`,
  );
};
const REGIONS = xml(
  "<DescribeRegionsResponse><regionInfo><item><regionName>eu-north-1</regionName></item></regionInfo></DescribeRegionsResponse>",
);
/** DescribeAlarms: one alarm in eu-north-1, whether asked by the sweep's probe or for ALARM. */
const ALARMS: Canned = () =>
  xml(
    "<R><CompositeAlarms/><MetricAlarms><member><AlarmName>rds-free-storage-low</AlarmName><MetricName>FreeStorageSpace</MetricName><Namespace>AWS/RDS</Namespace>" +
      "<StateValue>ALARM</StateValue><StateUpdatedTimestamp>2026-10-11T07:41:00Z</StateUpdatedTimestamp></member></MetricAlarms></R>",
  );
const COST = {
  "ce:GetCostAndUsage": json({
    ResultsByTime: [
      {
        Total: {},
        Groups: [
          { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "10", Unit: "USD" } } },
        ],
      },
    ],
  }),
  "ce:GetCostForecast": json({ Total: { Amount: "20", Unit: "USD" } }),
};

function setup(table: Record<string, Canned>, accounts = [KEY]) {
  const fake = fakeAws(
    {
      "sts:GetCallerIdentity": IDENTITY,
      "ec2:DescribeRegions": REGIONS,
      "cloudwatch:DescribeAlarms": xml("<R><MetricAlarms/></R>"),
      ...table,
    },
    accounts,
  );
  const now = () => clock;
  const accountsOf = new Accounts(() => fake.connections, now);
  const calls = new CallLog(folder, now);
  const cost = new CostStore(folder, accountsOf);
  const alarms = new AlarmWatch(folder, accountsOf, () => undefined);
  const deps: BoardDeps = {
    accounts: accountsOf,
    alarms,
    cost,
    calls,
    titleOf: (session) => (session.startsWith("4e1c90ab") ? "odi-5xx-spike" : null),
  };
  return { fake, deps, calls, cost, alarms };
}

const titles = (out: LaunchBoard, group: string) =>
  out.items.filter((each) => each.group === group).map((each) => each.title);

test("the board's sections are accounts, cost, alarms and calls, and every item sits in one", async () => {
  const { deps, cost, alarms } = setup({
    "iam:ListAccessKeys": KEYS,
    "iam:GetAccessKeyLastUsed": lastUsed,
    "cloudwatch:DescribeAlarms": ALARMS,
    ...COST,
  });
  await cost.refreshAll();
  await alarms.poll();
  const out = await board(deps, "");
  expect(out.columns.map((each) => each.id)).toEqual(["accounts", "cost", "alarms", "calls"]);
  expect(out.items.every((each) => out.columns.some((col) => col.id === each.group))).toBe(true);
  expect(titles(out, "accounts")).toEqual(["artemis-prod"]);
  expect(titles(out, "cost")).toEqual(["artemis-prod: $10.00 so far"]);
  expect(out.items.find((each) => each.group === "alarms")).toMatchObject({
    key: "aws-1|eu-north-1|rds-free-storage-low",
    title: "rds-free-storage-low",
    detail: "artemis-prod · eu-north-1 · AWS/RDS FreeStorageSpace",
    sub: "in ALARM since 2026-10-11T07:41:00Z",
    tone: "critical",
  });
});

test("accounts: who each key is, the access key in use, its age, and the rotate warning over 90 days", async () => {
  const { deps } = setup({ "iam:ListAccessKeys": KEYS, "iam:GetAccessKeyLastUsed": lastUsed }, [
    KEY,
    SECOND,
  ]);
  const out = await board(deps, "");
  const accounts = out.items.filter((each) => each.group === "accounts");
  expect(accounts).toHaveLength(2);
  expect(accounts[0]).toMatchObject({
    title: "artemis-prod",
    detail: "4821-0937-1150 · user/prifly",
    sub: "AKIA…7QX2 · 213 days old, rotate it · last used 2026-10-11",
    tone: "warning",
  });
});

test("accounts: a key IAM will not list is unknown, with the reason, and not flagged", async () => {
  const { deps } = setup({
    "iam:ListAccessKeys": xmlError("AccessDenied", "iam:ListAccessKeys denied"),
  });
  const out = await board(deps, "");
  expect(out.items.find((each) => each.group === "accounts")).toMatchObject({
    sub: "Access key age unknown: AWS answered AccessDenied: iam:ListAccessKeys denied",
    tone: "muted",
  });
});

test("accounts: a young key is good, a signed-out key says so and offers the sign-in", async () => {
  const { deps } = setup({
    "iam:ListAccessKeys": xml(
      "<R><AccessKeyMetadata><member><AccessKeyId>AKIAYOUNGYOUNGYOUNG</AccessKeyId><Status>Active</Status><CreateDate>2026-09-30T00:00:00Z</CreateDate></member></AccessKeyMetadata></R>",
    ),
    "iam:GetAccessKeyLastUsed": xml("<R/>"),
  });
  const young = await board(deps, "");
  expect(young.items.find((each) => each.group === "accounts")).toMatchObject({
    sub: "AKIA…OUNG · 11 days old · never used",
    tone: "good",
  });
  expect(young.actions).toBeUndefined();

  const dead = setup({}, [KEY]);
  dead.fake.endpoint.revoke("aws-1");
  const out = await board(dead.deps, "");
  expect(out.items.find((each) => each.group === "accounts")).toMatchObject({
    key: `${SIGN_IN}:aws-1`,
    detail: "4821-0937-1150 · The key needs signing in again.",
    tone: "critical",
  });
  expect(out.items.find((each) => each.group === "cost")).toMatchObject({ tone: "critical" });
  expect(out.actions?.map((each) => each.key)).toEqual([SIGN_IN]);
});

test("key missing: one Accounts row and an Add AWS key action, narrowed by the filter", async () => {
  const { deps } = setup({}, []);
  const out = await board(deps, "");
  expect(out.columns).toEqual([{ id: "accounts", name: "Accounts" }]);
  expect(out.items).toHaveLength(1);
  expect(out.items[0]).toMatchObject({
    key: SIGN_IN,
    title: "No AWS key is filed",
    tone: "warning",
  });
  expect(out.actions).toEqual([{ key: SIGN_IN, title: "Add AWS key", tone: "info" }]);
  // A filter that matches nothing is the board's own empty state: no columns, no items.
  expect(await board(deps, "zzz")).toMatchObject({ columns: [], items: [] });
});

test("cost: pending, ready, a note and a signed-out key each have their row", async () => {
  const pending = setup({});
  expect((await board(pending.deps, "")).items.find((e) => e.group === "cost")).toMatchObject({
    title: "artemis-prod",
    detail: "Not read yet: the daily reading comes soon.",
    tone: "muted",
  });

  const ready = setup(COST);
  await ready.cost.refreshAll();
  expect((await board(ready.deps, "")).items.find((e) => e.group === "cost")).toMatchObject({
    title: "artemis-prod: $10.00 so far",
    detail: "Amazon EC2 $10.00",
    sub: expect.stringContaining("forecast $30.00"),
    tone: "info",
  });

  rmSync(folder, { recursive: true, force: true });
  const off = setup({ "ce:GetCostAndUsage": jsonError("AccessDeniedException", "denied") });
  await off.cost.refreshAll();
  expect((await board(off.deps, "")).items.find((e) => e.group === "cost")).toMatchObject({
    detail: expect.stringContaining("may not read Cost Explorer"),
    tone: "warning",
  });
});

test("alarms: none in ALARM, not read yet, and a poll that failed each say so", async () => {
  const quiet = setup({});
  expect(titles(await board(quiet.deps, ""), "alarms")).toEqual(["Alarms not read yet"]);
  await quiet.alarms.poll();
  expect(titles(await board(quiet.deps, ""), "alarms")).toEqual(["No alarm is in ALARM"]);

  const dead = setup({});
  dead.fake.endpoint.revoke("aws-1");
  await dead.alarms.poll();
  expect(titles(await board(dead.deps, ""), "alarms")).toEqual([
    "Alarms of artemis-prod could not be read",
  ]);
});

test("calls: today's calls newest first, with the session's title, refusals marked", async () => {
  const { deps, calls } = setup({});
  expect(titles(await board(deps, ""), "calls")).toEqual(["No calls from sessions today"]);
  const entry = {
    account: "artemis-prod",
    service: "ec2",
    action: "DescribeInstances",
    region: "eu-north-1",
    kind: "read" as const,
    outcome: "Read",
  };
  calls.append({ ...entry, at: "2026-10-10T09:00:00.000Z", session: "old" });
  calls.append({ ...entry, at: "2026-10-11T09:14:00.000Z", session: "4e1c90ab-aaaa" });
  calls.append({
    ...entry,
    action: "TerminateInstances",
    kind: "refused",
    outcome: "Refused: read-only",
    at: "2026-10-11T09:30:00.000Z",
    session: "b71d2e05-bbbb",
  });
  const out = await board(deps, "");
  expect(titles(out, "calls")).toEqual(["ec2 TerminateInstances", "ec2 DescribeInstances"]);
  const rows = out.items.filter((each) => each.group === "calls");
  expect(rows[0]).toMatchObject({
    detail: expect.stringContaining("Refused: read-only"),
    tone: "warning",
  });
  expect(rows[1]?.sub).toStartWith("odi-5xx-spike");
  expect(rows[0]?.sub).toStartWith("b71d2e05");
});

test("the filter narrows every section, and drops the sections left empty", async () => {
  const { deps } = setup({ "iam:ListAccessKeys": KEYS, "iam:GetAccessKeyLastUsed": lastUsed });
  const out = await board(deps, "user/prifly");
  expect(out.columns.map((each) => each.id)).toEqual(["accounts"]);
});

test("the extension asks for no panel and puts nothing in prifly's status bar", async () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "prifly-extension.json"), "utf8"),
  );
  expect(manifest.panels).toBeUndefined();
  expect(manifest.launch.map((each: { id: string }) => each.id)).toEqual(["alarms"]);
  expect(module.panel).toBeUndefined();

  const fake = fakeApi({ folder });
  const stop = await module.activate(fake.api);
  try {
    await module.choices?.("alarms", "");
    expect(fake.shown.every((each) => each.statusBar.length === 0)).toBe(true);
    expect(fake.shown.flatMap((each) => each.statusBar)).toEqual([]);
  } finally {
    stop?.();
  }
});

test("the module registers the three tools and answers its board and its sign-in through activate", async () => {
  const fake = fakeApi({ folder });
  const stop = await module.activate(fake.api);
  try {
    expect(fake.tools().map((tool) => tool.name)).toEqual(["aws_whoami", "aws_call", "aws_cost"]);
    expect(await module.choices?.("alarms", "")).toMatchObject({
      columns: [{ id: "accounts" }],
      items: [{ key: SIGN_IN, title: "No AWS key is filed" }],
    });
    expect(await module.launch?.("alarms", "x|y|z", "", { again: false })).toMatchObject({
      prompt: "",
    });
    expect(await module.launch?.("alarms", "aws:call:0", "", { again: false })).toMatchObject({
      prompt: "",
      message: expect.stringContaining("only informs"),
    });
    expect(await module.launch?.("alarms", SIGN_IN, "", { again: false })).toMatchObject({
      prompt: "",
      message: "This prifly has no connections.",
    });
  } finally {
    stop?.();
  }
});

test("sign-in opens prifly's Add AWS key form and reads again afterwards", async () => {
  const aws = fakeAws(
    { "sts:GetCallerIdentity": IDENTITY, "ec2:DescribeRegions": xml("<r/>") },
    [],
  );
  const fake = fakeApi({ folder, connections: aws.connections });
  const stop = await module.activate(fake.api);
  try {
    const out = await module.launch?.("alarms", SIGN_IN, "", { again: false });
    expect(out).toMatchObject({ prompt: "", message: expect.stringContaining("filed") });
    expect(aws.accounts.map((each) => each.provider)).toEqual(["aws-keys"]);
  } finally {
    stop?.();
  }
});
