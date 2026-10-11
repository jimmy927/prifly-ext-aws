/**
 * Cost Explorer, read once per account per UTC day, and kept in `cost.json`
 * of the extension's folder. Each Cost Explorer call costs $0.01, so nothing
 * but this module calls it: `aws_call` refuses `ce`, `aws_cost` and the board
 * read what was kept.
 *
 * A day's reading is three calls: the month to date by service, the forecast
 * to month end, and the same days of last month. If the key may not read Cost
 * Explorer, or it is not enabled for the account, a note is kept in place of
 * the figures and the next try is tomorrow's.
 */

import type { ExtensionConnection } from "@prifly/extension-api";
import { type Accounts, failure } from "./accounts";
import { errorOf, type Params, type Reply } from "./aws";

/** What AWS answered: a `Reply` that is not the key asking for the reader. */
type Answer = Extract<Reply, { kind: "reply" }>;

import { readJson, utcDay, writeJson } from "./store";

const FILE = "cost.json";
const DAY_MS = 24 * 60 * 60 * 1000;

export type CostEntry = {
  /** The connection's id. */
  account: string;
  /** The UTC day this was read. */
  day: string;
  readAt: string;
  /** `2026-10` */
  month: string;
  /** Why there are no figures; null when there are. */
  note: string | null;
  /** The first and last day the month to date covers, or null when no full day has passed. */
  from: string | null;
  to: string | null;
  unit: string;
  monthToDate: number | null;
  byService: { service: string; amount: number }[];
  /** The whole month: the month to date plus the forecast for the rest. */
  forecast: number | null;
  /** The same days of last month. */
  lastMonthSameDays: number | null;
  /** Cost Explorer calls made this month. */
  reads: number;
};

type Store = Record<string, CostEntry>;

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function plusDays(day: string, days: number): string {
  return utcDay(dayMs(day) + days * DAY_MS);
}

/** Whether Cost Explorer said "not for you": no permission, or not enabled for the account. */
function refusal(status: number, text: string): string | null {
  const { code, message } = errorOf(text);
  if (
    code === "DataUnavailableException" ||
    /not enabled for cost explorer|User not enabled/i.test(message)
  ) {
    return "Cost Explorer is not enabled for this account: turn it on in the Billing console. Tried again tomorrow.";
  }
  if (/AccessDenied/.test(code) || status === 403) {
    return "This key may not read Cost Explorer (it needs ce:GetCostAndUsage and ce:GetCostForecast). Tried again tomorrow.";
  }
  return null;
}

function amountOf(value: unknown): number {
  const amount = Number(
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)["Amount"]
      : NaN,
  );
  return Number.isFinite(amount) ? amount : 0;
}

type Usage = { total: number; unit: string; byService: { service: string; amount: number }[] };

/** The sums in a GetCostAndUsage reply, with the groups when it was grouped by service. */
function usageOf(text: string): Usage {
  const body = JSON.parse(text) as { ResultsByTime?: Record<string, unknown>[] };
  const byService = new Map<string, number>();
  let total = 0;
  let unit = "USD";
  for (const period of body.ResultsByTime ?? []) {
    const metrics = period["Total"] as Record<string, unknown> | undefined;
    total += amountOf(metrics?.["UnblendedCost"]);
    for (const group of (period["Groups"] as Record<string, unknown>[] | undefined) ?? []) {
      const key = (group["Keys"] as string[] | undefined)?.[0] ?? "Other";
      const cost = (group["Metrics"] as Record<string, unknown> | undefined)?.["UnblendedCost"];
      byService.set(key, (byService.get(key) ?? 0) + amountOf(cost));
      const seen = (cost as Record<string, unknown> | undefined)?.["Unit"];
      if (typeof seen === "string") unit = seen;
    }
  }
  const rows = [...byService].map(([service, amount]) => ({ service, amount }));
  const sum = rows.reduce((all, row) => all + row.amount, 0);
  return {
    total: rows.length > 0 ? sum : total,
    unit,
    byService: rows.filter((row) => row.amount !== 0).sort((a, b) => b.amount - a.amount),
  };
}

function emptyEntry(connection: string, today: string, now: number, reads: number): CostEntry {
  return {
    account: connection,
    day: today,
    readAt: new Date(now).toISOString(),
    month: today.slice(0, 7),
    note: null,
    from: null,
    to: null,
    unit: "USD",
    monthToDate: null,
    byService: [],
    forecast: null,
    lastMonthSameDays: null,
    reads,
  };
}

export class CostStore {
  private readonly folder: string;
  private readonly accounts: Accounts;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<CostEntry | null>>();

  constructor(folder: string, accounts: Accounts) {
    this.folder = folder;
    this.accounts = accounts;
    this.now = accounts.now;
  }

  /** What was kept for the connection, whatever day it is from. */
  get(connection: string): CostEntry | null {
    return readJson<Store>(this.folder, FILE, {})[connection] ?? null;
  }

  /** Read every signed-in account that has no reading from today. */
  async refreshAll(): Promise<void> {
    for (const connection of this.accounts.list()) await this.refresh(connection);
  }

  /** Today's reading of one account: the kept one, or one new read (never twice a day). */
  refresh(connection: ExtensionConnection): Promise<CostEntry | null> {
    const held = this.get(connection.id);
    if (held?.day === utcDay(this.now()) || connection.state !== "ok") return Promise.resolve(held);
    const running = this.inflight.get(connection.id);
    if (running !== undefined) return running;
    const started = this.read(connection, held).finally(() => this.inflight.delete(connection.id));
    this.inflight.set(connection.id, started);
    return started;
  }

  private keep(entry: CostEntry): void {
    writeJson(this.folder, FILE, {
      ...readJson<Store>(this.folder, FILE, {}),
      [entry.account]: entry,
    });
  }

  /** One Cost Explorer call; null when the key must sign in again (nothing was spent). */
  private async ce(id: string, action: string, params: Params): Promise<Answer | null> {
    const reply = await this.accounts.call(id, "ce", action, params, "us-east-1");
    return reply.kind === "sign-in" ? null : reply;
  }

  private async read(
    connection: ExtensionConnection,
    held: CostEntry | null,
  ): Promise<CostEntry | null> {
    const today = utcDay(this.now());
    const first = `${today.slice(0, 7)}-01`;
    const entry = emptyEntry(
      connection.id,
      today,
      this.now(),
      held?.month === today.slice(0, 7) ? held.reads : 0,
    );
    try {
      const outcome = await this.fill(connection.id, entry, today, first);
      if (outcome === "sign-in") return held;
    } catch (error) {
      entry.note = `Cost Explorer could not be read: ${error instanceof Error ? error.message : String(error)}. Tried again tomorrow.`;
    }
    this.keep(entry);
    return entry;
  }

  private async fill(
    id: string,
    entry: CostEntry,
    today: string,
    first: string,
  ): Promise<"done" | "sign-in"> {
    let leading = true;
    if (today !== first) {
      const spent = await this.ce(id, "GetCostAndUsage", {
        TimePeriod: { Start: first, End: today },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      });
      if (spent === null) return "sign-in";
      entry.reads += 1;
      leading = false;
      if (spent.status >= 400) {
        entry.note =
          refusal(spent.status, spent.text) ?? `${failure(spent.text)} Tried again tomorrow.`;
        return "done";
      }
      const usage = usageOf(spent.text);
      Object.assign(entry, {
        monthToDate: usage.total,
        byService: usage.byService,
        unit: usage.unit,
        from: first,
        to: plusDays(today, -1),
      });
    }
    return this.fillRest(id, entry, today, first, leading);
  }

  private async fillRest(
    id: string,
    entry: CostEntry,
    today: string,
    first: string,
    leading: boolean,
  ): Promise<"done" | "sign-in"> {
    const next = utcDay(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1));
    const forecast = await this.ce(id, "GetCostForecast", {
      TimePeriod: { Start: today, End: next },
      Metric: "UNBLENDED_COST",
      Granularity: "MONTHLY",
    });
    if (forecast === null) return "sign-in";
    entry.reads += 1;
    if (forecast.status < 400) {
      entry.forecast =
        (entry.monthToDate ?? 0) +
        amountOf((JSON.parse(forecast.text) as Record<string, unknown>)["Total"]);
    } else if (leading) {
      entry.note =
        refusal(forecast.status, forecast.text) ??
        `${failure(forecast.text)} Tried again tomorrow.`;
      return "done";
    }
    return this.fillLastMonth(id, entry, today, first);
  }

  private async fillLastMonth(
    id: string,
    entry: CostEntry,
    today: string,
    first: string,
  ): Promise<"done" | "sign-in"> {
    const lastFirst = utcDay(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1));
    const passed = Number(today.slice(8, 10)) - 1;
    const end = utcDay(Math.min(dayMs(lastFirst) + passed * DAY_MS, dayMs(first)));
    if (end === lastFirst) return "done";
    const reply = await this.ce(id, "GetCostAndUsage", {
      TimePeriod: { Start: lastFirst, End: end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
    });
    if (reply === null) return "sign-in";
    entry.reads += 1;
    if (reply.status < 400) entry.lastMonthSameDays = usageOf(reply.text).total;
    return "done";
  }
}
