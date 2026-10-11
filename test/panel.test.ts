import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionModule, PanelRequest } from "@prifly/extension-api";
import { Accounts } from "../accounts";
import { AlarmWatch } from "../alarms";
import { CallLog } from "../calls";
import { CostStore } from "../cost";
import * as extension from "../index";
import { answer, type PanelDeps } from "../panel";
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
  folder = mkdtempSync(join(tmpdir(), "aws-panel-"));
  clock = Date.parse("2026-10-11T12:00:00Z");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const request = (path: string, query: Record<string, string> = {}): PanelRequest => ({
  path,
  query,
  body: null,
});

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

function setup(table: Record<string, Canned>, accounts = [KEY]) {
  const fake = fakeAws(
    {
      "sts:GetCallerIdentity": IDENTITY,
      "ec2:DescribeRegions": xml("<r><regionInfo/></r>"),
      ...table,
    },
    accounts,
  );
  const now = () => clock;
  const accountsOf = new Accounts(() => fake.connections, now);
  const calls = new CallLog(folder, now);
  const cost = new CostStore(folder, accountsOf);
  const alarms = new AlarmWatch(folder, accountsOf, () => undefined);
  let signedIn = 0;
  const deps: PanelDeps = {
    accounts: accountsOf,
    alarms,
    cost,
    calls,
    connections: () => fake.connections,
    titleOf: (session) => (session.startsWith("4e1c90ab") ? "odi-5xx-spike" : null),
    afterSignIn: () => {
      signedIn += 1;
    },
  };
  return { fake, deps, calls, cost, alarms, signedIn: () => signedIn };
}

test("accounts: who each key is, the access key in use, its age, and the rotate flag over 90 days", async () => {
  const { deps } = setup({ "iam:ListAccessKeys": KEYS, "iam:GetAccessKeyLastUsed": lastUsed }, [
    KEY,
    SECOND,
  ]);
  const out = (await answer(deps, request("accounts"))) as { accounts: Record<string, unknown>[] };
  expect(out.accounts).toHaveLength(2);
  expect(out.accounts[0]).toMatchObject({
    id: "aws-1",
    name: "artemis-prod",
    alias: "artemis-prod",
    accountId: "4821-0937-1150",
    state: "ok",
    identity: "user/prifly",
    problem: null,
    alarmRegions: [],
    key: {
      known: true,
      masked: "AKIA…7QX2",
      ageDays: 213,
      rotate: true,
      lastUsed: "2026-10-11T11:58:00.000Z",
    },
  });
});

test("accounts: a key IAM will not list is unknown, with the reason, and not rotate", async () => {
  const { deps } = setup({
    "iam:ListAccessKeys": xmlError("AccessDenied", "iam:ListAccessKeys denied"),
  });
  const out = (await answer(deps, request("accounts"))) as { accounts: { key: unknown }[] };
  expect(out.accounts[0]?.key).toEqual({
    known: false,
    reason: "AWS answered AccessDenied: iam:ListAccessKeys denied",
  });
});

test("accounts: a young key is not flagged, a signed-out key says so", async () => {
  const { deps } = setup({
    "iam:ListAccessKeys": xml(
      "<R><AccessKeyMetadata><member><AccessKeyId>AKIAYOUNGYOUNGYOUNG</AccessKeyId><Status>Active</Status><CreateDate>2026-09-30T00:00:00Z</CreateDate></member></AccessKeyMetadata></R>",
    ),
    "iam:GetAccessKeyLastUsed": xml("<R/>"),
  });
  const young = (await answer(deps, request("accounts"))) as {
    accounts: { key: Record<string, unknown> }[];
  };
  expect(young.accounts[0]?.key).toMatchObject({
    known: true,
    ageDays: 11,
    rotate: false,
    lastUsed: null,
  });
  const dead = setup({}, [KEY]);
  dead.fake.endpoint.revoke("aws-1");
  const out = (await answer(dead.deps, request("accounts"))) as {
    accounts: Record<string, unknown>[];
  };
  expect(out.accounts[0]).toMatchObject({
    state: "needs-sign-in",
    identity: null,
    problem: "The key needs signing in again.",
    key: { known: false },
  });
});

test("accounts with no key filed is an empty list", async () => {
  const { deps } = setup({}, []);
  expect(await answer(deps, request("accounts"))).toEqual({ accounts: [] });
});

test("cost: no key, pending, ready, a note and a key to sign in again each have their shape", async () => {
  expect(answer(setup({}, []).deps, request("cost"))).toMatchObject({
    account: null,
    status: "no-key",
  });

  const pending = setup({});
  expect(answer(pending.deps, request("cost"))).toEqual({
    account: "aws-1",
    name: "artemis-prod",
    status: "pending",
  });

  const ready = setup({
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
  });
  await ready.cost.refreshAll();
  expect(answer(ready.deps, request("cost", { account: "aws-1" }))).toMatchObject({
    status: "ready",
    entry: { monthToDate: 10, forecast: 30, byService: [{ service: "Amazon EC2", amount: 10 }] },
  });

  rmSync(folder, { recursive: true, force: true });
  const off = setup({ "ce:GetCostAndUsage": jsonError("AccessDeniedException", "denied") });
  await off.cost.refreshAll();
  expect(answer(off.deps, request("cost"))).toMatchObject({
    status: "note",
    note: expect.stringContaining("may not read Cost Explorer"),
  });

  rmSync(folder, { recursive: true, force: true });
  const dead = setup({});
  dead.fake.endpoint.revoke("aws-1");
  expect(answer(dead.deps, request("cost"))).toMatchObject({ status: "sign-in" });
});

test("alarms: the list with when it was read; refresh=1 polls first", async () => {
  const { deps, fake } = setup({
    "cloudwatch:DescribeAlarms": xml("<R><MetricAlarms/></R>"),
  });
  expect(await answer(deps, request("alarms"))).toEqual({ readAt: null, alarms: [], problems: [] });
  const polled = (await answer(deps, request("alarms", { refresh: "1" }))) as {
    readAt: string;
    alarms: unknown[];
  };
  expect(polled.readAt).toBe("2026-10-11T12:00:00.000Z");
  expect(polled.alarms).toEqual([]);
  expect(fake.sent.some((each) => each.service === "ec2")).toBe(true);
});

test("calls: today's calls newest first, with the session's title", async () => {
  const { deps, calls } = setup({});
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
  const out = answer(deps, request("calls")) as { calls: Record<string, unknown>[] };
  expect(out.calls.map((each) => each["action"])).toEqual([
    "TerminateInstances",
    "DescribeInstances",
  ]);
  expect(out.calls[1]).toMatchObject({ sessionTitle: "odi-5xx-spike", sessionShort: "4e1c90ab" });
  expect(out.calls[0]).toMatchObject({ sessionTitle: null, outcome: "Refused: read-only" });
});

test("sign-in opens prifly's Add AWS key form and reads again afterwards", async () => {
  const { deps, fake, signedIn } = setup({}, []);
  const out = await answer(deps, request("sign-in"));
  expect(out).toMatchObject({ ok: true });
  expect(fake.accounts.map((each) => each.provider)).toEqual(["aws-keys"]);
  expect(signedIn()).toBe(1);
});

test("a path the panel does not have is an error the page can show", () => {
  expect(() => answer(setup({}).deps, request("nope"))).toThrow("Nothing at api/nope");
});

test("the module registers the three tools, answers its launcher and its panel through activate", async () => {
  const fake = fakeApi({ folder });
  const stop = await module.activate(fake.api);
  try {
    expect(fake.tools().map((tool) => tool.name)).toEqual(["aws_whoami", "aws_call", "aws_cost"]);
    expect(await module.choices?.("alarms", "")).toEqual({ columns: [], items: [] });
    expect(await module.launch?.("alarms", "x|y|z", "", { again: false })).toMatchObject({
      prompt: "",
    });
    expect(await module.panel?.("aws", request("accounts"))).toEqual({ accounts: [] });
    expect(() => module.panel?.("aws", request("nope"))).toThrow("Nothing at api/nope");
  } finally {
    stop?.();
  }
});
