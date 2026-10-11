/**
 * The launcher `alarms`: one item per CloudWatch alarm in ALARM, across the
 * accounts, one column per account. Picking one starts a session that
 * investigates it with read-only `aws_call`s.
 */

import type { Launch, LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import type { AlarmRow } from "./alarms";

export function keyOf(row: AlarmRow): string {
  return [row.account, row.region, row.name].join("|");
}

/** The board of alarms in ALARM whose account, region, name or metric holds `query`. */
export function board(alarms: AlarmRow[], query: string): LaunchBoard {
  const wanted = query.trim().toLowerCase();
  const shown = alarms.filter((row) =>
    [row.accountName, row.region, row.name, row.metric].some((part) =>
      part.toLowerCase().includes(wanted),
    ),
  );
  const columns = [...new Map(shown.map((row) => [row.account, row.accountName])).entries()].map(
    ([id, name]) => ({
      id,
      name,
    }),
  );
  const items: LaunchChoice[] = shown.map((row) => ({
    key: keyOf(row),
    title: row.name,
    group: row.account,
    detail: `${row.region} · ${row.composite ? "composite alarm" : [row.namespace, row.metric].filter((part) => part !== "").join(" ")}`,
    ...(row.since === "" ? {} : { sub: `in ALARM since ${row.since}` }),
    tone: "critical",
  }));
  return { columns, items };
}

/** The session a picked alarm starts. */
export function launchOf(alarms: AlarmRow[], key: string): Launch {
  const row = alarms.find((each) => keyOf(each) === key);
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
