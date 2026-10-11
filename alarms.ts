/**
 * CloudWatch alarms in ALARM, read cheaply.
 *
 * Once a day, per account, EC2 DescribeRegions and one CloudWatch
 * DescribeAlarms in each region find the regions that have alarms at all
 * (kept in `alarm-regions.json`). Every five minutes only those regions are
 * asked for `StateValue=ALARM`. The launcher button glows while any alarm is
 * in ALARM.
 */

import type { ExtensionConnection, LauncherFlag } from "@prifly/extension-api";
import { type Accounts, failure, parseAccount } from "./accounts";
import { DEFAULT_REGION } from "./aws";
import { readJson, utcDay, writeJson } from "./store";
import { decode, inner, members, tag } from "./xml";

export const LAUNCHER = "alarms";
export const POLL_MS = 5 * 60 * 1000;
const FILE = "alarm-regions.json";
const PAGES = 5;

export type AlarmRow = {
  /** The connection's id. */
  account: string;
  accountName: string;
  region: string;
  name: string;
  metric: string;
  namespace: string;
  /** ISO time the alarm went into ALARM. */
  since: string;
  reason: string;
  composite: boolean;
};

type Regions = Record<string, { day: string; regions: string[] }>;

/** The alarms of a DescribeAlarms reply, and the token for the next page. */
export function parseAlarms(xml: string): {
  alarms: Omit<AlarmRow, "account" | "accountName" | "region">[];
  next: string | null;
} {
  const metric = members(inner(xml, "MetricAlarms") ?? "").map((each) => ({
    name: tag(each, "AlarmName") ?? "",
    metric: tag(each, "MetricName") ?? "",
    namespace: tag(each, "Namespace") ?? "",
    since: tag(each, "StateUpdatedTimestamp") ?? "",
    reason: tag(each, "StateReason") ?? "",
    composite: false,
  }));
  const composite = members(inner(xml, "CompositeAlarms") ?? "").map((each) => ({
    name: tag(each, "AlarmName") ?? "",
    metric: "composite alarm",
    namespace: "",
    since: tag(each, "StateUpdatedTimestamp") ?? "",
    reason: tag(each, "StateReason") ?? "",
    composite: true,
  }));
  const next = /<NextToken>([^<]+)<\/NextToken>/.exec(xml);
  return {
    alarms: [...metric, ...composite],
    next: next?.[1] === undefined ? null : decode(next[1]),
  };
}

export class AlarmWatch {
  private readonly folder: string;
  private readonly accounts: Accounts;
  private readonly flag: (flag: LauncherFlag | null) => void;
  private rows = new Map<string, AlarmRow[]>();
  private problems = new Map<string, string>();
  private readAt: number | null = null;
  private polling: Promise<void> | null = null;

  constructor(folder: string, accounts: Accounts, flag: (flag: LauncherFlag | null) => void) {
    this.folder = folder;
    this.accounts = accounts;
    this.flag = flag;
  }

  /** The alarms in ALARM at the last poll, across accounts, oldest first. */
  alarms(): AlarmRow[] {
    return [...this.rows.values()].flat().sort((a, b) => a.since.localeCompare(b.since));
  }

  /** When the alarms were last read (ms), null before the first poll finished. */
  lastRead(): number | null {
    return this.readAt;
  }

  /** What went wrong reading an account, by connection id. */
  problemOf(connection: string): string | null {
    return this.problems.get(connection) ?? null;
  }

  regionsOf(connection: string): string[] {
    return readJson<Regions>(this.folder, FILE, {})[connection]?.regions ?? [];
  }

  /** One poll of every signed-in account; a poll already running is joined, not doubled. */
  poll(): Promise<void> {
    this.polling ??= this.pollAll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollAll(): Promise<void> {
    const connections = this.accounts.list();
    const live = new Set(connections.map((each) => each.id));
    for (const key of [...this.rows.keys()]) {
      if (!live.has(key.split("|")[0] ?? "")) this.rows.delete(key);
    }
    for (const connection of connections) {
      if (connection.state === "ok") await this.pollAccount(connection);
      else {
        // Its last-known alarms would be stale, and would keep the launcher glowing.
        this.forget(connection.id, () => true);
        this.problems.set(connection.id, "The key needs signing in again.");
      }
    }
    this.readAt = this.accounts.now();
    const count = this.alarms().length;
    this.flag(
      count === 0
        ? null
        : { tone: "critical", hint: `${count} CloudWatch alarm${count === 1 ? "" : "s"} in ALARM` },
    );
  }

  private async pollAccount(connection: ExtensionConnection): Promise<void> {
    this.problems.delete(connection.id);
    const regions = await this.known(connection);
    if (regions === null) return;
    // A region the sweep dropped has no alarms left: forget what it held.
    this.forget(connection.id, (region) => !regions.includes(region));
    for (const region of regions) {
      const found = await this.inRegion(connection, region);
      if (found !== null) this.rows.set(`${connection.id}|${region}`, found);
    }
  }

  /** Drop the kept rows of `connection` whose region `gone` says so. */
  private forget(connection: string, gone: (region: string) => boolean): void {
    for (const key of [...this.rows.keys()]) {
      const [id, region = ""] = key.split("|");
      if (id === connection && gone(region)) this.rows.delete(key);
    }
  }

  /** The regions with alarms: the day's sweep, made when there is none from today. */
  private async known(connection: ExtensionConnection): Promise<string[] | null> {
    const today = utcDay(this.accounts.now());
    const held = readJson<Regions>(this.folder, FILE, {})[connection.id];
    if (held?.day === today) return held.regions;
    const swept = await this.sweep(connection);
    if (swept === null) return held?.regions ?? null;
    writeJson(this.folder, FILE, {
      ...readJson<Regions>(this.folder, FILE, {}),
      [connection.id]: { day: today, regions: swept },
    });
    return swept;
  }

  /** Every enabled region, asked for one alarm of any state; the ones that have one. */
  private async sweep(connection: ExtensionConnection): Promise<string[] | null> {
    try {
      const listed = await this.accounts.call(
        connection.id,
        "ec2",
        "DescribeRegions",
        {},
        DEFAULT_REGION,
      );
      if (listed.kind === "sign-in") return null;
      if (listed.status >= 400) {
        this.problems.set(connection.id, failure(listed.text));
        return null;
      }
      const all = [...listed.text.matchAll(/<regionName>([^<]+)<\/regionName>/g)].flatMap(
        (each) => each[1] ?? [],
      );
      const have: string[] = [];
      for (const region of all) {
        const reply = await this.accounts.call(
          connection.id,
          "cloudwatch",
          "DescribeAlarms",
          { MaxRecords: 1, AlarmTypes: ["MetricAlarm", "CompositeAlarm"] },
          region,
        );
        if (reply.kind === "reply" && reply.status < 400 && /<member>/.test(reply.text))
          have.push(region);
      }
      return have;
    } catch (error) {
      this.problems.set(connection.id, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /** The alarms in ALARM in one region (null: it could not be read, keep what was known). */
  private async inRegion(
    connection: ExtensionConnection,
    region: string,
  ): Promise<AlarmRow[] | null> {
    const name = parseAccount(connection.account).name;
    const out: AlarmRow[] = [];
    try {
      let token: string | null = null;
      for (let page = 0; page < PAGES; page += 1) {
        const reply = await this.accounts.call(
          connection.id,
          "cloudwatch",
          "DescribeAlarms",
          {
            StateValue: "ALARM",
            AlarmTypes: ["MetricAlarm", "CompositeAlarm"],
            MaxRecords: 100,
            ...(token === null ? {} : { NextToken: token }),
          },
          region,
        );
        if (reply.kind === "sign-in") return null;
        if (reply.status >= 400) {
          this.problems.set(connection.id, `${region}: ${failure(reply.text)}`);
          return null;
        }
        const parsed = parseAlarms(reply.text);
        out.push(
          ...parsed.alarms.map((each) => ({
            ...each,
            account: connection.id,
            accountName: name,
            region,
          })),
        );
        token = parsed.next;
        if (token === null) break;
      }
    } catch (error) {
      this.problems.set(connection.id, error instanceof Error ? error.message : String(error));
      return null;
    }
    return out;
  }
}
