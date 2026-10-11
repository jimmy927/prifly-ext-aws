import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../accounts";
import { CostStore } from "../cost";
import { type Canned, fakeAws, json, jsonError, KEY, SECOND } from "./fake-aws";

let folder = "";
let clock = 0;
const at = (iso: string) => Date.parse(iso);
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aws-cost-"));
  clock = at("2026-10-11T08:00:00Z");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const service = (name: string, amount: string) => ({
  Keys: [name],
  Metrics: { UnblendedCost: { Amount: amount, Unit: "USD" } },
});

/** Month to date for the first call, the same days of last month for the ungrouped one. */
const usage: Canned = (_request, body) => {
  const asked = JSON.parse(body) as { GroupBy?: unknown };
  if (asked.GroupBy === undefined) {
    return json({
      ResultsByTime: [{ Total: { UnblendedCost: { Amount: "389.10", Unit: "USD" } }, Groups: [] }],
    });
  }
  return json({
    ResultsByTime: [
      {
        Total: {},
        Groups: [
          service("Amazon EC2", "201.55"),
          service("Amazon RDS", "88.20"),
          service("Tax", "0"),
        ],
      },
    ],
  });
};
const forecast = json({ Total: { Amount: "773.63", Unit: "USD" } });

function setup(table: Record<string, Canned>, accounts = [KEY]) {
  const fake = fakeAws(table, accounts);
  const accountsOf = new Accounts(
    () => fake.connections,
    () => clock,
  );
  const store = new CostStore(folder, accountsOf);
  const ceCalls = () =>
    fake.sent.filter((each) => each.service === "ce").map((each) => each.target);
  return { fake, store, accountsOf, ceCalls };
}

test("a reading is month to date by service, the forecast to month end and the same days of last month", async () => {
  const { store, ceCalls, fake } = setup({
    "ce:GetCostAndUsage": usage,
    "ce:GetCostForecast": forecast,
  });
  await store.refreshAll();
  expect(ceCalls()).toEqual([
    "AWSInsightsIndexService.GetCostAndUsage",
    "AWSInsightsIndexService.GetCostForecast",
    "AWSInsightsIndexService.GetCostAndUsage",
  ]);
  const bodies = fake.sent.map((each) => JSON.parse(each.body));
  expect(bodies[0]).toEqual({
    TimePeriod: { Start: "2026-10-01", End: "2026-10-11" },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  });
  expect(bodies[1]).toEqual({
    TimePeriod: { Start: "2026-10-11", End: "2026-11-01" },
    Metric: "UNBLENDED_COST",
    Granularity: "MONTHLY",
  });
  expect(bodies[2].TimePeriod).toEqual({ Start: "2026-09-01", End: "2026-09-11" });
  expect(fake.sent.every((each) => each.region === "us-east-1")).toBe(true);
  expect(store.get("aws-1")).toMatchObject({
    day: "2026-10-11",
    from: "2026-10-01",
    to: "2026-10-10",
    note: null,
    monthToDate: 289.75,
    byService: [
      { service: "Amazon EC2", amount: 201.55 },
      { service: "Amazon RDS", amount: 88.2 },
    ],
    forecast: 289.75 + 773.63,
    lastMonthSameDays: 389.1,
    reads: 3,
  });
});

test("Cost Explorer is called at most once per account per day", async () => {
  const { store, ceCalls } = setup(
    { "ce:GetCostAndUsage": usage, "ce:GetCostForecast": forecast },
    [KEY, SECOND],
  );
  await store.refreshAll();
  expect(ceCalls()).toHaveLength(6);
  await store.refreshAll();
  clock += 6 * 3_600_000; // 14:00, same UTC day
  await Promise.all([store.refreshAll(), store.refreshAll()]);
  expect(ceCalls()).toHaveLength(6);
  clock = at("2026-10-12T00:30:00Z");
  await store.refreshAll();
  expect(ceCalls()).toHaveLength(12);
  expect(store.get("aws-1")).toMatchObject({ day: "2026-10-12", reads: 6 });
});

test("two refreshes at once share one reading", async () => {
  const { store, ceCalls } = setup({ "ce:GetCostAndUsage": usage, "ce:GetCostForecast": forecast });
  await Promise.all([store.refreshAll(), store.refreshAll(), store.refreshAll()]);
  expect(ceCalls()).toHaveLength(3);
});

test("a key that may not read Cost Explorer stores a note, calls once, and tries again tomorrow", async () => {
  const denied = jsonError(
    "AccessDeniedException",
    "User is not authorized to perform: ce:GetCostAndUsage",
    400,
  );
  const { store, ceCalls } = setup({ "ce:GetCostAndUsage": denied, "ce:GetCostForecast": denied });
  await store.refreshAll();
  expect(ceCalls()).toHaveLength(1);
  const kept = store.get("aws-1");
  expect(kept?.note).toContain("may not read Cost Explorer");
  expect(kept).toMatchObject({ monthToDate: null, forecast: null, byService: [], reads: 1 });
  await store.refreshAll();
  expect(ceCalls()).toHaveLength(1);
  clock = at("2026-10-12T09:00:00Z");
  await store.refreshAll();
  expect(ceCalls()).toHaveLength(2);
});

test("Cost Explorer not enabled for the account stores its own note", async () => {
  for (const [code, message] of [
    ["DataUnavailableException", "Data is not available."],
    ["AccessDeniedException", "User not enabled for cost explorer access."],
    ["ValidationException", "Account is not enabled for Cost Explorer"],
  ] as const) {
    const { store } = setup({ "ce:GetCostAndUsage": jsonError(code, message) });
    await store.refreshAll();
    expect(store.get("aws-1")?.note).toContain("not enabled for this account");
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the reading survives a restart: a new store reads the kept file and does not call again", async () => {
  const first = setup({ "ce:GetCostAndUsage": usage, "ce:GetCostForecast": forecast });
  await first.store.refreshAll();
  const second = setup({ "ce:GetCostAndUsage": usage, "ce:GetCostForecast": forecast });
  await second.store.refreshAll();
  expect(second.ceCalls()).toHaveLength(0);
  expect(second.store.get("aws-1")?.monthToDate).toBe(289.75);
});

test("a key that needs signing in is not read and nothing is stored", async () => {
  const { store, fake, ceCalls } = setup({ "ce:GetCostAndUsage": usage });
  fake.endpoint.revoke("aws-1");
  await store.refreshAll();
  expect(ceCalls()).toHaveLength(0);
  expect(store.get("aws-1")).toBeNull();
});

test("on the first of the month there is no month to date and no same-days figure, only the forecast", async () => {
  clock = at("2026-10-01T08:00:00Z");
  const { store, ceCalls } = setup({ "ce:GetCostAndUsage": usage, "ce:GetCostForecast": forecast });
  await store.refreshAll();
  expect(ceCalls()).toEqual(["AWSInsightsIndexService.GetCostForecast"]);
  expect(store.get("aws-1")).toMatchObject({
    monthToDate: null,
    from: null,
    forecast: 773.63,
    lastMonthSameDays: null,
    reads: 1,
  });
});

test("the same days of last month stop at the end of a shorter month", async () => {
  clock = at("2026-03-31T08:00:00Z");
  const { store, fake } = setup({ "ce:GetCostAndUsage": usage, "ce:GetCostForecast": forecast });
  await store.refreshAll();
  expect(JSON.parse(fake.sent[2]?.body ?? "{}").TimePeriod).toEqual({
    Start: "2026-02-01",
    End: "2026-03-01",
  });
});
