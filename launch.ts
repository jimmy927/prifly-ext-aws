/**
 * The launcher `alarms`, the AWS board: sections for the accounts, the cost,
 * the CloudWatch alarms in ALARM and the day's calls. Picking an alarm starts
 * a session that investigates it with read-only `aws_call`s; the other rows
 * only inform. Nothing of the extension is in prifly's status bar.
 */

import type {
  DecorationTone,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchColumn,
} from "@prifly/extension-api";
import { type Accounts, type KeyInfo, NO_KEY, parseAccount } from "./accounts";
import type { AlarmRow, AlarmWatch } from "./alarms";
import type { CallLog } from "./calls";
import type { CostStore } from "./cost";

export function keyOf(row: AlarmRow): string {
  return [row.account, row.region, row.name].join("|");
}

/** The sections of the board, in the order they are laid out: one column each. */
export const SECTIONS: LaunchColumn[] = [
  { id: "accounts", name: "Accounts" },
  { id: "cost", name: "Cost this month" },
  { id: "alarms", name: "Alarms in ALARM" },
  { id: "calls", name: "Calls from sessions today" },
];

/** The key prefix of every row that is not an alarm; picking one starts no session. */
const INFO = "aws:";
/** The key of the rows and the action that open prifly's "Add AWS key" form. */
export const SIGN_IN = `${INFO}sign-in`;

/** Everything the board shows, read at the moment the launcher opens. */
export type BoardDeps = {
  accounts: Accounts;
  alarms: AlarmWatch;
  cost: CostStore;
  calls: CallLog;
  /** A session's title, when prifly still knows it. */
  titleOf: (session: string) => string | null;
};

const TODAY_CALLS = 40;

function money(amount: number | null, unit: string): string {
  if (amount === null) return "–";
  const whole = Math.abs(amount) >= 1000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: unit,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

function clock(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function keyLine(key: KeyInfo): { text: string; tone: DecorationTone } {
  if (!key.known) return { text: `Access key age unknown: ${key.reason}`, tone: "muted" };
  const used = key.lastUsed === null ? "never used" : `last used ${key.lastUsed.slice(0, 10)}`;
  const age = `${key.ageDays} day${key.ageDays === 1 ? "" : "s"} old`;
  return key.rotate
    ? { text: `${key.masked} · ${age}, rotate it · ${used}`, tone: "warning" }
    : { text: `${key.masked} · ${age} · ${used}`, tone: "good" };
}

function matching(items: LaunchChoice[], query: string): LaunchChoice[] {
  const wanted = query.trim().toLowerCase();
  return items.filter((item) =>
    [item.title, item.detail ?? "", item.sub ?? ""].some((part) =>
      part.toLowerCase().includes(wanted),
    ),
  );
}

/** No key filed: the one section says so, and the board's action offers the sign-in. */
function keyMissing(query: string): LaunchBoard {
  const item: LaunchChoice = {
    key: SIGN_IN,
    title: "No AWS key is filed",
    group: "accounts",
    detail: NO_KEY,
    sub: "Pick this to open the Add AWS key form",
    tone: "warning",
  };
  const items = matching([item], query);
  return {
    columns: items.length === 0 ? [] : SECTIONS.slice(0, 1),
    items,
    actions: [{ key: SIGN_IN, title: "Add AWS key", tone: "info" }],
  };
}

async function accountItems(deps: BoardDeps): Promise<LaunchChoice[]> {
  return Promise.all(
    deps.accounts.list().map(async (each): Promise<LaunchChoice> => {
      const parsed = parseAccount(each.account);
      const identity = await deps.accounts.identity(each);
      if (typeof identity === "string" && each.state === "ok") {
        // Signed in, but AWS would not say who: a failure to look at, not a key to sign in.
        return {
          key: `${INFO}account:${each.id}`,
          title: parsed.name,
          group: "accounts",
          detail: `${parsed.accountId} · ${identity}`,
          sub: "Could not read who this key is",
          tone: "warning",
        };
      }
      if (typeof identity === "string" || each.state !== "ok") {
        return {
          key: `${SIGN_IN}:${each.id}`,
          title: parsed.name,
          group: "accounts",
          detail: `${parsed.accountId} · ${typeof identity === "string" ? identity : "The key needs signing in again."}`,
          sub: "Pick this to sign the key in again",
          tone: "critical",
        };
      }
      const key = keyLine(await deps.accounts.keyInfo(each));
      const regions = deps.alarms.regionsOf(each.id);
      const who = [parsed.accountId, identity.who].filter((part) => part !== "").join(" · ");
      return {
        key: `${INFO}account:${each.id}`,
        title: parsed.name,
        group: "accounts",
        detail: regions.length === 0 ? who : `${who} · alarms in ${regions.join(", ")}`,
        sub: key.text,
        tone: key.tone,
      };
    }),
  );
}

function costItem(deps: BoardDeps, id: string, name: string, state: string): LaunchChoice {
  const base = { key: `${INFO}cost:${id}`, title: name, group: "cost" };
  if (state !== "ok") {
    return { ...base, detail: "The key needs signing in again.", tone: "critical" };
  }
  const entry = deps.cost.get(id);
  if (entry === null) {
    return { ...base, detail: "Not read yet: the daily reading comes soon.", tone: "muted" };
  }
  if (entry.note !== null) return { ...base, detail: entry.note, tone: "warning" };
  const top = entry.byService
    .slice(0, 3)
    .map((each) => `${each.service} ${money(each.amount, entry.unit)}`)
    .join(" · ");
  const outlook = [
    entry.forecast === null
      ? ""
      : `forecast ${money(entry.forecast, entry.unit)} for ${entry.month}`,
    entry.lastMonthSameDays === null
      ? ""
      : `last month, same days ${money(entry.lastMonthSameDays, entry.unit)}`,
  ].filter((part) => part !== "");
  return {
    ...base,
    title: `${name}: ${money(entry.monthToDate, entry.unit)} so far`,
    detail: top === "" ? "No cost by service yet" : top,
    ...(outlook.length === 0 ? {} : { sub: outlook.join(" · ") }),
    tone: "info",
  };
}

function alarmItems(deps: BoardDeps): LaunchChoice[] {
  const rows = deps.alarms.alarms().map(
    (row): LaunchChoice => ({
      key: keyOf(row),
      title: row.name,
      group: "alarms",
      detail: `${row.accountName} · ${row.region} · ${row.composite ? "composite alarm" : [row.namespace, row.metric].filter((part) => part !== "").join(" ")}`,
      ...(row.since === "" ? {} : { sub: `in ALARM since ${row.since}` }),
      tone: "critical",
    }),
  );
  const problems = deps.accounts.list().flatMap((each): LaunchChoice[] => {
    const problem = deps.alarms.problemOf(each.id);
    return problem === null
      ? []
      : [
          {
            key: `${INFO}alarm-problem:${each.id}`,
            title: `Alarms of ${parseAccount(each.account).name} could not be read`,
            group: "alarms",
            detail: problem,
            tone: "warning",
          },
        ];
  });
  if (rows.length > 0 || problems.length > 0) return [...rows, ...problems];
  const readAt = deps.alarms.lastRead();
  return [
    {
      key: `${INFO}alarms-none`,
      title: readAt === null ? "Alarms not read yet" : "No alarm is in ALARM",
      group: "alarms",
      detail:
        readAt === null
          ? "The first reading comes within a minute of starting."
          : `Read at ${clock(new Date(readAt))}`,
      tone: readAt === null ? "muted" : "good",
    },
  ];
}

function callItems(deps: BoardDeps): LaunchChoice[] {
  const today = deps.calls.today();
  if (today.length === 0) {
    return [
      {
        key: `${INFO}calls-none`,
        title: "No calls from sessions today",
        group: "calls",
        tone: "muted",
      },
    ];
  }
  return today.slice(0, TODAY_CALLS).map(
    (entry, index): LaunchChoice => ({
      key: `${INFO}call:${index}`,
      title: `${entry.service} ${entry.action}`,
      group: "calls",
      detail: `${entry.account} · ${entry.region} · ${entry.outcome}`,
      sub: `${deps.titleOf(entry.session) ?? entry.session.slice(0, 8)} · ${clock(new Date(entry.at))}`,
      tone: entry.kind === "read" ? "good" : entry.kind === "refused" ? "warning" : "critical",
    }),
  );
}

/**
 * The AWS board: accounts, cost, alarms in ALARM and the day's calls as its
 * sections (one column each), narrowed to what the reader typed. Reading the
 * accounts can take a moment, which is the board's own loading state; a
 * failure thrown here is its error state, and a filter that matches nothing
 * its empty state. A section with nothing left after the filter is dropped.
 */
export async function board(deps: BoardDeps, query: string): Promise<LaunchBoard> {
  const accounts = deps.accounts.list();
  if (accounts.length === 0) return keyMissing(query);
  const cost = accounts.map((each) =>
    costItem(deps, each.id, parseAccount(each.account).name, each.state),
  );
  const items = matching(
    [...(await accountItems(deps)), ...cost, ...alarmItems(deps), ...callItems(deps)],
    query,
  );
  const present = new Set(items.map((item) => item.group));
  const needsKey = accounts.some((each) => each.state !== "ok");
  return {
    columns: SECTIONS.filter((each) => present.has(each.id)),
    items,
    ...(needsKey
      ? { actions: [{ key: SIGN_IN, title: "Sign an AWS key in", tone: "info" as const }] }
      : {}),
  };
}

/** The session a picked alarm starts. */
export function launchOf(alarms: AlarmRow[], key: string): Launch {
  const row = alarms.find((each) => keyOf(each) === key);
  if (row === undefined && key.startsWith(INFO)) {
    return { prompt: "", message: "That row only informs: pick an alarm to investigate it." };
  }
  if (row === undefined) {
    return {
      prompt: "",
      message: "That alarm is no longer in ALARM (or the list is being read again): pick another.",
    };
  }
  const what = row.composite
    ? "a composite alarm"
    : `the metric ${[row.namespace, row.metric].filter((part) => part !== "").join(" ")}`;
  return {
    name: `alarm ${row.name}`.slice(0, 60),
    prompt: [
      `The CloudWatch alarm "${row.name}" is in ALARM.`,
      `Account: ${row.accountName} (connection ${row.account}). Region: ${row.region}. It watches ${what}.`,
      row.since === "" ? "" : `It went into ALARM at ${row.since}.`,
      row.reason === "" ? "" : `AWS gave this reason: ${row.reason}`,
      "",
      "Investigate it with the read-only `aws_call` tool (every call is read-only; writes are refused):",
      `- DescribeAlarms with AlarmNames.member.1 set to the alarm, for its threshold, dimensions and actions (service cloudwatch, region ${row.region}).`,
      "- GetMetricData (or GetMetricStatistics) for its metric from about an hour before the state change to now, to see what moved and when.",
      "- logs FilterLogEvents on the log groups that belong to the resource in its dimensions, around the state change.",
      "- Describe* calls for the resource itself (instances, load balancers, databases) when the dimensions name one.",
      "",
      "Then report: what the alarm measures, what happened and when, the most likely cause with the evidence, and what the reader could do about it. Change nothing.",
    ]
      .filter((line, index, all) => line !== "" || all[index - 1] !== "")
      .join("\n"),
  };
}
