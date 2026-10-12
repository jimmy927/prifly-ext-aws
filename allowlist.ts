/**
 * What `aws_call` may send. Pure: no network, no state.
 *
 * Version 1 is read-only. A call runs only when its action is a read, and
 * three things are refused even though they read:
 *  - a secret or a credential (`secret`): the session would see it;
 *  - a Cost Explorer call (`cost`): each costs money, and the daily reading
 *    (`cost.ts`) is the only reader of it;
 * everything else is a write (`write`). Every refusal says which rule and
 * that the extension is read-only.
 */

import type { Params } from "./aws";

export type Rule = "secret" | "cost" | "write";

export type Verdict = { allowed: true } | { allowed: false; rule: Rule; message: string };

/** The word a refusal gets in the call log and on the board. */
export const REFUSED_OUTCOME: Record<Rule, string> = {
  write: "Refused: read-only",
  secret: "Refused: would reveal a secret",
  cost: "Refused: costs money",
};

const READ_PREFIX = /^(Describe|List|Get|Search|Lookup|BatchGet)(?=[A-Z0-9]|$)/;
/** A `Get*` that hands out a secret, a password, a token or a key. */
const SECRET_NAME = /Secret|Password|Token|Credential|AccessDetails|PrivateKey|KeyPair/;
/** Reads whose names do not start like one. */
const OTHER_READS = new Set(["dynamodb:Query", "dynamodb:Scan", "logs:FilterLogEvents"]);
const SSM_PARAMETER = new Set(["GetParameter", "GetParameters", "GetParametersByPath"]);
const SSM_WORDS = "decrypts a SecureString parameter";

const SUFFIX = "prifly-ext-aws is read-only in v1: it changes nothing in AWS.";

function refuse(rule: Rule, reason: string): Verdict {
  return { allowed: false, rule, message: `${REFUSED_OUTCOME[rule]}. ${reason} ${SUFFIX}` };
}

/** A parameter by name, whatever its case. */
function param(params: Params, name: string): unknown {
  const wanted = name.toLowerCase();
  const found = Object.entries(params).find(([key]) => key.toLowerCase() === wanted);
  return found?.[1];
}

function isTrue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

/** The secret-revealing rules; a message when one applies, else null. */
function secretReason(service: string, action: string, params: Params): string | null {
  if (service === "sts" && action !== "GetCallerIdentity") {
    return `sts ${action} hands out credentials (only GetCallerIdentity is allowed).`;
  }
  if (action.startsWith("Get") && SECRET_NAME.test(action)) {
    return `${service} ${action} returns a secret, password, token or key.`;
  }
  if (service === "ssm" && SSM_PARAMETER.has(action) && isTrue(param(params, "WithDecryption"))) {
    return `${service} ${action} with WithDecryption ${SSM_WORDS}.`;
  }
  const attribute = param(params, "Attribute");
  if (
    service === "ec2" &&
    action === "DescribeInstanceAttribute" &&
    typeof attribute === "string" &&
    attribute.toLowerCase() === "userdata"
  ) {
    return "ec2 DescribeInstanceAttribute for userData can hold a script with secrets in it.";
  }
  return null;
}

/** May `service` `action` with `params` be sent, and if not, which rule says so and in what words. */
export function judge(service: string, action: string, params: Params = {}): Verdict {
  const name = service.trim().toLowerCase();
  if (name === "ce") {
    return refuse(
      "cost",
      `ce ${action} costs $0.01 a call. prifly reads Cost Explorer once a day per account: use aws_cost.`,
    );
  }
  const secret = secretReason(name, action, params);
  if (secret !== null) return refuse("secret", secret);
  if (READ_PREFIX.test(action) || OTHER_READS.has(`${name}:${action}`)) return { allowed: true };
  return refuse(
    "write",
    `${name} ${action} is not a read (the allowed ones start with Describe, List, Get, Search, Lookup or BatchGet).`,
  );
}

export const REDACTED = "[redacted by prifly]";

function redactAll(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(values).map((key) => [key, REDACTED]));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace `field` of each object in a list (ECS `environment`, `secrets`). */
function redactEntries(list: unknown[], field: string): unknown[] {
  return list.map((entry) =>
    isObject(entry) && field in entry ? { ...entry, [field]: REDACTED } : walk(entry),
  );
}

function redactedEntry(key: string, value: unknown): unknown {
  if (key === "Environment" && isObject(value) && isObject(value["Variables"])) {
    return { ...value, Variables: redactAll(value["Variables"]) };
  }
  if (key === "environment" && Array.isArray(value)) return redactEntries(value, "value");
  if (key === "secrets" && Array.isArray(value)) return redactEntries(value, "valueFrom");
  // GetFunction's download link for the code is a signed URL.
  if (key === "Code" && isObject(value) && "Location" in value)
    return { ...value, Location: REDACTED };
  return walk(value);
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inside]) => [key, redactedEntry(key, inside)]),
  );
}

/**
 * A reply with the values that are secrets in practice taken out: Lambda
 * `Environment` variables, ECS container `environment` and `secrets`, the
 * signed download link of a Lambda's code, an EC2 launch template's
 * `userData`. A reply that is neither JSON nor XML with those is returned as it is.
 */
export function redact(text: string): string {
  const start = text.trimStart()[0];
  if (start === "{" || start === "[") {
    try {
      return JSON.stringify(walk(JSON.parse(text)));
    } catch {
      return text;
    }
  }
  return text.replace(/<(userData)>[\s\S]*?<\/\1>/gi, `<$1>${REDACTED}</$1>`);
}
