/**
 * The tools every session sees as `mcp__prifly__aws_*`: `aws_api` (any AWS
 * API action; reads at once, writes only after the reader confirms them on a
 * card, secret-revealing calls and Cost Explorer refused), `aws_api_docs`
 * (how to call an action, from its botocore model), `aws_whoami` and
 * `aws_cost`. Each answers text and never throws for what AWS said.
 */

import type { ConfirmSpec, ExtensionTool } from "@prifly/extension-api";
import { type Accounts, failure, parseAccount } from "./accounts";
import { judge, redact } from "./allowlist";
import { type AwsRequest, AwsUsageError, DEFAULT_REGION, type Params } from "./aws";
import type { CostEntry, CostStore } from "./cost";
import { actionDocs, serviceDocs } from "./docs";
import { operationOf } from "./model-request";

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

export type Deps = {
  accounts: Accounts;
  cost: CostStore;
  /** `api.confirm`; absent on a prifly too old to ask, where every write is not done. */
  confirm?: (spec: ConfirmSpec) => Promise<boolean>;
  log: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

const ACCOUNT_ARG = {
  type: "string",
  description: "A connection id, account id or alias; left out, the only or first key.",
};

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
        account: ACCOUNT_ARG,
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

function apiTool(deps: Deps): ExtensionTool {
  return {
    name: "aws_api",
    description:
      "Calls any AWS API action of any service with the reader's filed key (prifly signs it) and returns AWS's reply as text, cut to about 40 kB with the token to page on. Reads (Describe*, List*, Get*, Search*, Lookup*, BatchGet*, dynamodb Query/Scan, logs FilterLogEvents) run at once. Any other action is a write: the reader sees a confirm card with the service, action, region, account and params, and it runs only if they confirm; \"Not done: you cancelled\" means nothing was sent. Refused whatever the reader says: calls that reveal a secret (GetSecretValue, GetPasswordData, GetAuthorizationToken, sts other than GetCallerIdentity, ssm WithDecryption, ec2 userData, new access keys and key pairs, kms Decrypt/GenerateDataKey/GenerateDataKeyPair, sso-oidc CreateToken, cognito-idp InitiateAuth/AdminInitiateAuth/RespondToAuthChallenge) and Cost Explorer (use aws_cost). Lambda and ECS environment values come back redacted. Params by protocol: Query services (ec2, iam, rds, sns, cloudwatch, …) take flat or nested params (lists and objects are flattened); JSON services take the request body; REST services (s3, lambda, route53, …) take the action's members by name and each goes to the URI, query, header or body as the model says. For an action you do not know, call aws_api_docs first.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "The aws CLI's service name: ec2, s3, lambda, logs, route53, elbv2, …",
        },
        action: { type: "string", description: "The API action, e.g. DescribeInstances." },
        params: { type: "object", description: "The action's parameters." },
        region: { type: "string", description: `Default ${DEFAULT_REGION}.` },
        account: ACCOUNT_ARG,
      },
      required: ["service", "action"],
      additionalProperties: false,
    },
    call: (args) => apiCall(deps, args),
  };
}

type Call = { service: string; action: string; params: Params; region: string };

function callOf(args: Record<string, unknown>): Call {
  return {
    service: text(args, "service").toLowerCase(),
    action: text(args, "action"),
    params: paramsOf(args),
    region: text(args, "region") || DEFAULT_REGION,
  };
}

/** "CreateBucket" -> "create bucket"; "DBInstance" runs stay together ("describe DB instances"). */
export function humanAction(action: string): string {
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(" ")
    .map((word, i) => (i === 0 || !/^[A-Z]{2,}$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

/** The params that name what an action is about, most telling first. */
const TARGET_KEYS = [
  "Name",
  "BucketName",
  "Bucket",
  "FunctionName",
  "InstanceIds",
  "InstanceId",
  "DBInstanceIdentifier",
  "DBClusterIdentifier",
  "ClusterName",
  "TableName",
  "QueueName",
  "TopicArn",
  "RoleName",
  "UserName",
  "GroupName",
  "StackName",
  "LogGroupName",
  "HostedZoneId",
  "VolumeId",
  "KeyName",
  "SecretId",
  "Key",
];

const MAX_VALUE = 80;

function short(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_VALUE ? `${one.slice(0, MAX_VALUE - 1)}…` : one;
}

/** One param value as a short readable string; nested objects and long lists are summarised. */
function readable(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return short(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.every((v) => ["string", "number", "boolean"].includes(typeof v))) {
      return short(value.join(", "));
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  const count = Object.keys(value as object).length;
  return `${count} field${count === 1 ? "" : "s"}`;
}

/** The obvious target of the call, if a param names one. */
function targetOf(params: Params): string | null {
  for (const key of TARGET_KEYS) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    const text = readable(value);
    if (text !== "" && !text.endsWith(" fields") && !text.endsWith(" items")) return text;
  }
  return null;
}

/** The confirm card of a write: a sentence, the readable params, and the technical request folded away. */
export function confirmSpec(call: Call, account: string, request: AwsRequest): ConfirmSpec {
  const region =
    request.region === call.region ? call.region : `${request.region} (global service)`;
  const verb = humanAction(call.action);
  const target = targetOf(call.params);
  const what = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} with ${call.service}`;
  const sentence = `${what}${target === null ? "" : `, on ${target}`}, in ${region} for account ${account}.`;
  const lines = Object.entries(call.params).map(([key, value]) => `${key}: ${readable(value)}`);
  return {
    title: `AWS ${call.action}`,
    summary: sentence,
    content: lines.join("\n"),
    details: [
      `Service:  ${call.service}`,
      `Action:   ${call.action}`,
      `Region:   ${region}`,
      `Account:  ${account}`,
      `Request:  ${request.method} ${request.url}`,
      "",
      "Params:",
      JSON.stringify(call.params, null, 2),
    ].join("\n"),
  };
}

export const CANCELLED = "Not done: you cancelled";
const CANNOT_ASK =
  "Not done: this prifly cannot show a confirm card, so aws_api makes no write. Ask the reader to update prifly.";

/** Whether the reader confirmed the write; the words to answer with when not. */
async function confirmed(deps: Deps, spec: ConfirmSpec): Promise<string | null> {
  if (deps.confirm === undefined) return CANNOT_ASK;
  try {
    return (await deps.confirm(spec)) ? null : CANCELLED;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Not done: the confirm card failed (${message}).`;
  }
}

async function apiCall(deps: Deps, args: Record<string, unknown>): Promise<string> {
  const call = callOf(args);
  const verdict = judge(call.service, call.action, call.params);
  if (verdict.kind === "refused") return verdict.message;
  const picked = deps.accounts.resolve(text(args, "account"));
  if (!picked.ok) return picked.message;
  let request: AwsRequest;
  try {
    request = await deps.accounts.prepare(call.service, call.action, call.params, call.region);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AwsUsageError ? message : `Could not prepare the call: ${message}`;
  }
  const account = picked.connection.account;
  // A backstop for REST models: a PUT, DELETE or PATCH changes something, whatever its name.
  const write = verdict.kind === "write" || ["PUT", "DELETE", "PATCH"].includes(request.method);
  if (write) {
    const refusal = await confirmed(deps, confirmSpec(call, account, request));
    if (refusal !== null) {
      deps.log("write_not_done", { service: call.service, action: call.action, why: refusal });
      return refusal;
    }
  }
  const answer = await sendCall(deps, picked.connection.id, call, request);
  if (write) {
    deps.log("write", {
      service: call.service,
      action: call.action,
      region: request.region,
      account,
      outcome: answer.outcome,
    });
  }
  return answer.text;
}

async function sendCall(
  deps: Deps,
  id: string,
  call: Call,
  request: AwsRequest,
): Promise<{ text: string; outcome: string }> {
  try {
    const reply = await deps.accounts.send(id, request);
    if (reply.kind === "sign-in") return { text: SIGN_IN, outcome: "sign-in" };
    if (reply.status >= 400) {
      return {
        text: `${failure(reply.text)} (HTTP ${reply.status}, ${call.service} ${call.action} in ${request.region}.)`,
        outcome: `HTTP ${reply.status}`,
      };
    }
    const body =
      reply.text.trim() === ""
        ? `AWS answered HTTP ${reply.status} with no body: done.`
        : trim(redact(reply.text));
    return { text: body, outcome: `HTTP ${reply.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Could not call AWS: ${message}`, outcome: "failed" };
  }
}

function docsTool(deps: Deps): ExtensionTool {
  return {
    name: "aws_api_docs",
    description:
      "How to call an AWS API action, read from its botocore service model on GitHub (the newest API version; kept while prifly runs). Without action: the service's protocol, endpoint prefix, API version and its operation names. With action: how aws_api sends it (HTTP method and URI, or target), whether it is a read, a write that asks the reader, or refused, its required params, and its input and output shapes a few levels deep with trimmed docs. Use it before calling an action you do not know.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "The aws CLI's service name: ec2, s3, lambda, route53, elbv2, …",
        },
        action: { type: "string", description: "One operation, e.g. PutBucketTagging." },
      },
      required: ["service"],
      additionalProperties: false,
    },
    call: async (args) => {
      const service = text(args, "service").toLowerCase();
      const action = text(args, "action");
      try {
        const model = await deps.accounts.models.load(service);
        if (action === "") return serviceDocs(model);
        return actionDocs(model, operationOf(model, model.service, action));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return error instanceof AwsUsageError ? message : `Could not read the AWS docs: ${message}`;
      }
    },
  };
}

export function awsTools(deps: Deps): ExtensionTool[] {
  return [whoamiTool(deps), apiTool(deps), docsTool(deps), costTool(deps)];
}
