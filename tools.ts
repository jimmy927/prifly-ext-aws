/**
 * The tools every session sees as `mcp__prifly__aws_*`. Read-only: a call off
 * the allowlist is refused with the rule that refused it (`allowlist.ts`),
 * never sent. Each answers text and never throws for what AWS said.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { type Accounts, failure, parseAccount } from "./accounts";
import { judge, REFUSED_OUTCOME, redact } from "./allowlist";
import { AwsUsageError, DEFAULT_REGION, errorOf, type Params, supportedServices } from "./aws";
import type { CallKind, CallLog } from "./calls";
import type { CostEntry, CostStore } from "./cost";

/** Longer replies are cut here, with a note of how to read on. */
export const MAX_REPLY = 40_000;

const SIGN_IN =
  "AWS no longer accepts this key (deleted, deactivated or rotated). Do not retry: ask the reader to re-check or re-add it in prifly's Vault → Connections.";

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

function paramsOf(args: Record<string, unknown>): Params {
  const value = args["params"];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Params)
    : {};
}

/** The token a reply names for its next page, and the parameter to pass it as. */
export function pageToken(reply: string): { param: string; value: string } | null {
  const xml =
    /<(NextToken|nextToken|Marker|NextMarker|NextContinuationToken|NextPageToken)>([^<]+)<\//.exec(
      reply,
    );
  if (xml?.[1] !== undefined && xml[2] !== undefined) {
    return { param: wireName(xml[1], true), value: xml[2] };
  }
  const json = /"(nextToken|NextToken|NextMarker|Marker|NextPageToken)"\s*:\s*"([^"]+)"/.exec(
    reply,
  );
  return json?.[1] !== undefined && json[2] !== undefined
    ? { param: wireName(json[1], false), value: json[2] }
    : null;
}

function wireName(found: string, xml: boolean): string {
  if (found === "NextMarker") return "Marker";
  if (found === "NextContinuationToken") return "ContinuationToken";
  return xml ? found.charAt(0).toUpperCase() + found.slice(1) : found;
}

/** `reply`, cut to about 40 kB, with a note saying how to read on when it is cut or has a next page. */
export function trim(reply: string): string {
  const token = pageToken(reply);
  const cut = reply.length > MAX_REPLY;
  const notes: string[] = [];
  if (cut)
    notes.push(
      `Cut at ${MAX_REPLY} of ${reply.length} characters: narrow the call (Filter, MaxResults, a prefix).`,
    );
  if (token !== null)
    notes.push(`More pages: call again with ${token.param}=${token.value} in params.`);
  if (/"LastEvaluatedKey"/.test(reply))
    notes.push("More pages: pass LastEvaluatedKey back as ExclusiveStartKey.");
  const body = cut ? reply.slice(0, MAX_REPLY) : reply;
  return notes.length === 0 ? body : `${body}\n\n[${notes.join(" ")}]`;
}

function money(value: number | null, unit: string): string {
  return value === null ? "unknown" : `${value.toFixed(2)} ${unit}`;
}

/** The kept Cost Explorer reading, as words for a session. */
export function costText(name: string, entry: CostEntry | null): string {
  if (entry === null) {
    return `No cost reading of ${name} yet: prifly-ext-aws reads Cost Explorer once a day per account, and has not read this one.`;
  }
  if (entry.note !== null) return `No cost figures for ${name}: ${entry.note}`;
  return JSON.stringify(
    {
      account: name,
      readAt: entry.readAt,
      month: entry.month,
      period: entry.from === null ? null : `${entry.from} to ${entry.to}`,
      monthToDate: money(entry.monthToDate, entry.unit),
      forecastForMonth: money(entry.forecast, entry.unit),
      sameDaysLastMonth: money(entry.lastMonthSameDays, entry.unit),
      byService: entry.byService.map((row) => ({
        service: row.service,
        amount: row.amount.toFixed(2),
      })),
      note: "Unblended cost, read from Cost Explorer once a day. Never a live call.",
    },
    null,
    1,
  );
}

type Deps = { accounts: Accounts; calls: CallLog; cost: CostStore; now: () => number };

function whoamiTool(deps: Deps): ExtensionTool {
  return {
    name: "aws_whoami",
    description:
      "Lists the AWS keys the reader filed in prifly (account, whether the key still works, the IAM identity it is: from STS GetCallerIdentity, kept a few minutes). Read-only; no secret is ever shown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: async () => {
      const connections = deps.accounts.list();
      if (connections.length === 0)
        return "No AWS key is filed yet: add one in prifly's Vault → Connections (Add AWS key).";
      const rows = await Promise.all(
        connections.map(async (each) => {
          const identity = await deps.accounts.identity(each);
          const parsed = parseAccount(each.account);
          return {
            connection: each.id,
            account: parsed.name,
            accountId: parsed.accountId,
            state: each.state,
            ...(typeof identity === "string"
              ? { problem: identity }
              : { identity: identity.who, arn: identity.arn }),
          };
        }),
      );
      return JSON.stringify(rows, null, 1);
    },
  };
}

function costTool(deps: Deps): ExtensionTool {
  return {
    name: "aws_cost",
    description:
      "The cached daily Cost Explorer reading of an AWS account: month to date by service, the forecast for the month and the same days of last month. Never a live call (Cost Explorer charges per call, so prifly reads it once a day).",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "A connection id, account id or alias; left out, the only or first key.",
        },
      },
      additionalProperties: false,
    },
    call: async (args) => {
      const picked = deps.accounts.resolve(text(args, "account"));
      if (!picked.ok) return picked.message;
      return costText(
        parseAccount(picked.connection.account).name,
        deps.cost.get(picked.connection.id),
      );
    },
  };
}

function callTool(deps: Deps): ExtensionTool {
  return {
    name: "aws_call",
    description: `Makes one read-only AWS API call and returns AWS's reply as text (XML for the Query services, JSON for the others), cut to about 40 kB with the token to page on. Services: ${supportedServices().join(", ")}. Only reads run: Describe*, List*, Get*, Search*, Lookup*, BatchGet*, dynamodb Query/Scan and logs FilterLogEvents. Anything that changes AWS, reveals a secret (GetSecretValue, GetPasswordData, GetAuthorizationToken, sts other than GetCallerIdentity, ssm WithDecryption, ec2 userData) or costs money (Cost Explorer: use aws_cost) is refused. Lambda and ECS environment values are redacted. s3 offers ListBuckets, ListObjectsV2 and GetBucketLocation; lambda ListFunctions and GetFunction. Query services take flat params (\`{"InstanceId.1":"i-0abc"}\`; lists and objects are flattened); JSON services take the request body.`,
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "ec2, cloudwatch, logs, rds, s3, lambda, …" },
        action: { type: "string", description: "The API action, e.g. DescribeInstances." },
        params: { type: "object", description: "The action's parameters." },
        region: { type: "string", description: `Default ${DEFAULT_REGION}.` },
        account: {
          type: "string",
          description: "A connection id, account id or alias; left out, the only or first key.",
        },
      },
      required: ["service", "action"],
      additionalProperties: false,
    },
    call: (args, ctx) => makeCall(deps, ctx.session, args),
  };
}

async function makeCall(
  deps: Deps,
  session: string,
  args: Record<string, unknown>,
): Promise<string> {
  const service = text(args, "service").toLowerCase();
  const action = text(args, "action");
  const params = paramsOf(args);
  const region = text(args, "region") || DEFAULT_REGION;
  const picked = deps.accounts.resolve(text(args, "account"));
  const record = (kind: CallKind, outcome: string): void =>
    deps.calls.append({
      at: new Date(deps.now()).toISOString(),
      session,
      account: picked.ok ? parseAccount(picked.connection.account).name : "",
      service,
      action,
      region,
      kind,
      outcome,
    });
  const verdict = judge(service, action, params);
  if (!verdict.allowed) {
    record("refused", REFUSED_OUTCOME[verdict.rule]);
    return verdict.message;
  }
  if (!picked.ok) {
    record("failed", "Failed: no key");
    return picked.message;
  }
  try {
    const reply = await deps.accounts.call(picked.connection.id, service, action, params, region);
    if (reply.kind === "sign-in") {
      record("sign-in", "Key needs signing in");
      return SIGN_IN;
    }
    if (reply.status >= 400) {
      record("failed", `Failed: ${errorOf(reply.text).code || reply.status}`);
      return `${failure(reply.text)} (HTTP ${reply.status}, ${service} ${action} in ${region}.)`;
    }
    record("read", "Read");
    return trim(redact(reply.text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(
      "failed",
      error instanceof AwsUsageError ? "Failed: not supported" : "Failed: could not call",
    );
    return error instanceof AwsUsageError ? message : `Could not call AWS: ${message}`;
  }
}

export function awsTools(deps: Deps): ExtensionTool[] {
  return [whoamiTool(deps), callTool(deps), costTool(deps)];
}
