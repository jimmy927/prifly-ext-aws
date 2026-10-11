/**
 * The wire shapes of the AWS APIs the extension speaks, and the one function
 * that sends them: `api.connections.fetch(id, url, { region, service, … })`,
 * where prifly signs the request with SigV4. Nothing here holds a secret.
 *
 * Three shapes, one table (`SERVICES`):
 *  - Query: a form POST with `Action` and `Version`, an XML reply;
 *  - JSON 1.0 / 1.1: a JSON POST with `X-Amz-Target`;
 *  - REST: a GET for the few S3 and Lambda reads, each its own URL.
 * Replies are returned as text; callers cut out the facts they need.
 */

import type { ExtensionConnectionsApi } from "@prifly/extension-api";
import { decode } from "./xml";

export const DEFAULT_REGION = "eu-north-1";

/** A value of `aws_call`'s `params`. */
export type Params = Record<string, unknown>;

type QueryService = {
  protocol: "query";
  /** The SigV4 signing name. */
  signing: string;
  /** The host's first label: `<prefix>.<region>.amazonaws.com`. */
  host: string;
  version: string;
  /** A global service: its host and the region it is signed for. */
  global?: { host: string; region: string };
};
type JsonService = {
  protocol: "json";
  signing: string;
  host: string;
  /** `1.0` or `1.1`, in the content type. */
  json: "1.0" | "1.1";
  target: string;
  global?: { host: string; region: string };
};
type RestService = { protocol: "rest"; signing: string; host: string };
type Service = QueryService | JsonService | RestService;

export const SERVICES: Readonly<Record<string, Service>> = {
  sts: { protocol: "query", signing: "sts", host: "sts", version: "2011-06-15" },
  ec2: { protocol: "query", signing: "ec2", host: "ec2", version: "2016-11-15" },
  iam: {
    protocol: "query",
    signing: "iam",
    host: "iam",
    version: "2010-05-08",
    global: { host: "iam.amazonaws.com", region: "us-east-1" },
  },
  rds: { protocol: "query", signing: "rds", host: "rds", version: "2014-10-31" },
  elasticloadbalancing: {
    protocol: "query",
    signing: "elasticloadbalancing",
    host: "elasticloadbalancing",
    version: "2015-12-01",
  },
  sns: { protocol: "query", signing: "sns", host: "sns", version: "2010-03-31" },
  cloudformation: {
    protocol: "query",
    signing: "cloudformation",
    host: "cloudformation",
    version: "2010-05-15",
  },
  // CloudWatch's host and signing name are both `monitoring`.
  cloudwatch: {
    protocol: "query",
    signing: "monitoring",
    host: "monitoring",
    version: "2010-08-01",
  },
  logs: { protocol: "json", signing: "logs", host: "logs", json: "1.1", target: "Logs_20140328" },
  ce: {
    protocol: "json",
    signing: "ce",
    host: "ce",
    json: "1.1",
    target: "AWSInsightsIndexService",
    global: { host: "ce.us-east-1.amazonaws.com", region: "us-east-1" },
  },
  dynamodb: {
    protocol: "json",
    signing: "dynamodb",
    host: "dynamodb",
    json: "1.0",
    target: "DynamoDB_20120810",
  },
  ecs: {
    protocol: "json",
    signing: "ecs",
    host: "ecs",
    json: "1.1",
    target: "AmazonEC2ContainerServiceV20141113",
  },
  s3: { protocol: "rest", signing: "s3", host: "s3" },
  lambda: { protocol: "rest", signing: "lambda", host: "lambda" },
};

const ALIASES: Record<string, string> = {
  monitoring: "cloudwatch",
  elb: "elasticloadbalancing",
  elbv2: "elasticloadbalancing",
};

/** `aws_call` cannot reach `ce`: only the daily reading (`cost.ts`) does. */
const NOT_FOR_SESSIONS = new Set(["ce"]);

export function normalService(name: string): string {
  const lower = name.trim().toLowerCase();
  return ALIASES[lower] ?? lower;
}

export function supportedServices(): string[] {
  return Object.keys(SERVICES).filter((name) => !NOT_FOR_SESSIONS.has(name));
}

/** What a request asked for that cannot be built: an unknown service or action, a missing parameter. */
export class AwsUsageError extends Error {}

/** A request ready for `api.connections.fetch`. */
export type AwsRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  region: string;
  service: string;
};

const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function scalar(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The Query protocol's flat parameters. Nested lists and objects are spelled
 * out the way the protocol does: `Name.1` for EC2, `Name.member.1` for the
 * rest, `Parent.Child` for an object.
 */
export function flatten(params: Params, ec2: boolean): [string, string][] {
  const out: [string, string][] = [];
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        add(`${key}.${ec2 ? "" : "member."}${index + 1}`, item);
      });
    } else if (typeof value === "object") {
      for (const [child, inside] of Object.entries(value)) add(`${key}.${child}`, inside);
    } else {
      out.push([key, scalar(value)]);
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return out;
}

function form(pairs: [string, string][]): string {
  return pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function regionalHost(service: Service, region: string): string {
  return `${service.host}.${region}.amazonaws.com`;
}

function queryRequest(
  service: QueryService,
  action: string,
  params: Params,
  region: string,
): AwsRequest {
  const where = service.global ?? { host: regionalHost(service, region), region };
  const pairs: [string, string][] = [
    ["Action", action],
    ["Version", service.version],
    ...flatten(params, service.signing === "ec2"),
  ];
  return {
    url: `https://${where.host}/`,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: form(pairs),
    region: where.region,
    service: service.signing,
  };
}

function jsonRequest(
  service: JsonService,
  action: string,
  params: Params,
  region: string,
): AwsRequest {
  const where = service.global ?? { host: regionalHost(service, region), region };
  return {
    url: `https://${where.host}/`,
    method: "POST",
    headers: {
      "content-type": `application/x-amz-json-${service.json}`,
      "x-amz-target": `${service.target}.${action}`,
    },
    body: JSON.stringify(params),
    region: where.region,
    service: service.signing,
  };
}

/** The query-string names a REST read takes, by the parameter's name in the API's own words. */
const REST_QUERY: Record<string, Record<string, string>> = {
  ListBuckets: {
    MaxBuckets: "max-buckets",
    ContinuationToken: "continuation-token",
    Prefix: "prefix",
  },
  ListObjectsV2: {
    Prefix: "prefix",
    Delimiter: "delimiter",
    MaxKeys: "max-keys",
    ContinuationToken: "continuation-token",
    StartAfter: "start-after",
  },
  GetBucketLocation: {},
  ListFunctions: { Marker: "Marker", MaxItems: "MaxItems", FunctionVersion: "FunctionVersion" },
  GetFunction: { Qualifier: "Qualifier" },
};

function queryString(action: string, params: Params, fixed: string[]): string {
  const names = REST_QUERY[action] ?? {};
  const pairs: string[] = [...fixed];
  for (const [name, wire] of Object.entries(names)) {
    const value = params[name];
    if (value !== undefined && value !== null) {
      pairs.push(`${encodeURIComponent(wire)}=${encodeURIComponent(scalar(value))}`);
    }
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

function needed(params: Params, name: string, action: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AwsUsageError(`${action} needs "${name}" in params.`);
  }
  return value.trim();
}

/** A bucket's URL: virtual-hosted, or path style for a name with dots (their certificate would not match). */
function bucketBase(bucket: string, host: string): string {
  return /^[a-z0-9][a-z0-9-]*$/.test(bucket)
    ? `https://${bucket}.${host}/`
    : `https://${host}/${encodeURIComponent(bucket)}`;
}

function s3Request(action: string, params: Params, region: string): AwsRequest {
  const base = { method: "GET" as const, headers: {}, service: "s3" };
  if (action === "ListBuckets") {
    return {
      ...base,
      url: `https://s3.amazonaws.com/${queryString(action, params, [])}`,
      region: "us-east-1",
    };
  }
  if (action === "ListObjectsV2") {
    const bucket = needed(params, "Bucket", action);
    const url =
      bucketBase(bucket, `s3.${region}.amazonaws.com`) +
      queryString(action, params, ["list-type=2"]);
    return { ...base, url, region };
  }
  if (action === "GetBucketLocation") {
    const bucket = needed(params, "Bucket", action);
    return {
      ...base,
      url: `${bucketBase(bucket, "s3.amazonaws.com")}?location`,
      region: "us-east-1",
    };
  }
  throw new AwsUsageError("s3 supports only ListBuckets, ListObjectsV2 and GetBucketLocation.");
}

function lambdaRequest(action: string, params: Params, region: string): AwsRequest {
  const root = `https://lambda.${region}.amazonaws.com/2015-03-31/functions`;
  const base = { method: "GET" as const, headers: {}, region, service: "lambda" };
  if (action === "ListFunctions") return { ...base, url: root + queryString(action, params, []) };
  if (action === "GetFunction") {
    const name = needed(params, "FunctionName", action);
    return {
      ...base,
      url: `${root}/${encodeURIComponent(name)}${queryString(action, params, [])}`,
    };
  }
  throw new AwsUsageError("lambda supports only ListFunctions and GetFunction.");
}

/** The request for `service` `action`, or an `AwsUsageError` saying what is missing. */
export function buildRequest(
  service: string,
  action: string,
  params: Params,
  region: string,
): AwsRequest {
  const name = normalService(service);
  const def = SERVICES[name];
  if (def === undefined) {
    throw new AwsUsageError(
      `Unknown service "${service}". Supported services: ${supportedServices().join(", ")}.`,
    );
  }
  if (!NAME.test(action)) throw new AwsUsageError(`"${action}" is not an AWS action name.`);
  switch (def.protocol) {
    case "query":
      return queryRequest(def, action, params, region);
    case "json":
      return jsonRequest(def, action, params, region);
    case "rest":
      return name === "s3"
        ? s3Request(action, params, region)
        : lambdaRequest(action, params, region);
  }
}

/** What AWS answered, or that the key needs the reader. */
export type Reply =
  | { kind: "reply"; status: number; text: string }
  | { kind: "sign-in"; account: string };

/** Send `request` as connection `id`; prifly signs it. Throws what the host refuses outright. */
export async function send(
  connections: ExtensionConnectionsApi,
  id: string,
  request: AwsRequest,
): Promise<Reply> {
  const answer = await connections.fetch(id, request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    region: request.region,
    service: request.service,
  });
  if ("needsSignIn" in answer) return { kind: "sign-in", account: answer.needsSignIn.account };
  return { kind: "reply", status: answer.status, text: await answer.text() };
}

/** AWS's error code and message from an XML or JSON error body ("" when it has none). */
export function errorOf(text: string): { code: string; message: string } {
  const xml = /<Code>([^<]*)<\/Code>/.exec(text);
  if (xml !== null) {
    const message = /<Message>([^<]*)<\/Message>/.exec(text);
    return { code: decode(xml[1] ?? ""), message: decode(message?.[1] ?? "") };
  }
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const type = body["__type"] ?? body["code"] ?? body["Code"];
    const message = body["message"] ?? body["Message"];
    const code = typeof type === "string" ? (type.split("#").pop() ?? "") : "";
    return { code, message: typeof message === "string" ? message : "" };
  } catch {
    return { code: "", message: "" };
  }
}
