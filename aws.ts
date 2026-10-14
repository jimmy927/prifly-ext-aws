/**
 * The wire shapes of the AWS APIs the extension speaks, and the one function
 * that sends them: `api.connections.fetch(id, url, { region, service, … })`,
 * where prifly signs the request with SigV4. Nothing here holds a secret.
 *
 * The services in `SERVICES` are built from the table alone, without the
 * network:
 *  - Query: a form POST with `Action` and `Version`, an XML reply;
 *  - JSON 1.0 / 1.1: a JSON POST with `X-Amz-Target`.
 * Every other service, and every REST one (s3, lambda, route53, …), is built
 * from its botocore model (`model-request.ts`), which reuses the two builders
 * here for the Query and JSON services it finds. Replies are returned as
 * text; callers cut out the facts they need.
 */

import type { ExtensionConnectionsApi } from "@prifly/extension-api";
import { decode } from "./xml";

export const DEFAULT_REGION = "eu-north-1";

/** A value of `aws_api`'s `params`. */
export type Params = Record<string, unknown>;

export type QueryService = {
  protocol: "query";
  /** The SigV4 signing name. */
  signing: string;
  /** The host's first label: `<prefix>.<region>.amazonaws.com`. */
  host: string;
  version: string;
  /** EC2's dialect: lists flatten as `Name.1`, not `Name.member.1`. */
  ec2?: boolean;
  /** A global service: its host and the region it is signed for. */
  global?: { host: string; region: string };
};
export type JsonService = {
  protocol: "json";
  signing: string;
  host: string;
  /** `1.0` or `1.1`, in the content type. */
  json: "1.0" | "1.1";
  target: string;
  global?: { host: string; region: string };
};
type Service = QueryService | JsonService;

export const SERVICES: Readonly<Record<string, Service>> = {
  sts: { protocol: "query", signing: "sts", host: "sts", version: "2011-06-15" },
  ec2: { protocol: "query", signing: "ec2", host: "ec2", version: "2016-11-15", ec2: true },
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
};

const ALIASES: Record<string, string> = {
  monitoring: "cloudwatch",
  elb: "elasticloadbalancing",
  elbv2: "elasticloadbalancing",
};

export function normalService(name: string): string {
  const lower = name.trim().toLowerCase();
  return ALIASES[lower] ?? lower;
}

/** What a request asked for that cannot be built: an unknown service or action, a missing parameter. */
export class AwsUsageError extends Error {}

/** A request ready for `api.connections.fetch`. */
export type AwsRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  region: string;
  service: string;
};

export const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export function scalar(value: unknown): string {
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

export function queryRequest(
  service: QueryService,
  action: string,
  params: Params,
  region: string,
): AwsRequest {
  const where = service.global ?? { host: regionalHost(service, region), region };
  const pairs: [string, string][] = [
    ["Action", action],
    ["Version", service.version],
    ...flatten(params, service.ec2 === true),
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

export function jsonRequest(
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

/**
 * The request for `service` `action` from the table; null for a service the
 * table does not hold (its botocore model builds it instead). An action that
 * is not a name is an `AwsUsageError`.
 */
export function buildRequest(
  service: string,
  action: string,
  params: Params,
  region: string,
): AwsRequest | null {
  if (!NAME.test(action)) throw new AwsUsageError(`"${action}" is not an AWS action name.`);
  const def = SERVICES[normalService(service)];
  if (def === undefined) return null;
  return def.protocol === "query"
    ? queryRequest(def, action, params, region)
    : jsonRequest(def, action, params, region);
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
