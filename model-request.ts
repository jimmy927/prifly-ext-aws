/**
 * A request built from a botocore model, for any service and action the
 * model holds: the Query and JSON services through the builders of `aws.ts`,
 * and the REST ones (rest-json, rest-xml) here. A REST action's members go
 * where the model says: the URI, the query string, a header, or the body
 * (JSON, or XML named and namespaced as the model says); a payload member is
 * the whole body. An S3 bucket goes in the host when its name allows.
 */

import { createHash } from "node:crypto";
import {
  type AwsRequest,
  AwsUsageError,
  buildRequest,
  type JsonService,
  jsonRequest,
  NAME,
  type Params,
  queryRequest,
  scalar,
} from "./aws";
import {
  type Member,
  type Models,
  type Operation,
  protocolOf,
  type ServiceModel,
  type Shape,
} from "./models";
import { escapeXml } from "./xml";

/** The request for `service` `action`: from the table when it holds the service, else from the model. */
export async function requestFor(
  models: Models,
  service: string,
  action: string,
  params: Params,
  region: string,
): Promise<AwsRequest> {
  const table = buildRequest(service, action, params, region);
  if (table !== null) return table;
  return modelRequest(await models.load(service), action, params, region);
}

export function operationOf(model: ServiceModel, service: string, action: string): Operation {
  const op = model.operations[action];
  if (op !== undefined) return op;
  const lower = action.toLowerCase();
  const close = Object.keys(model.operations)
    .filter((name) => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()))
    .slice(0, 10);
  const hint = close.length === 0 ? "" : ` Close ones: ${close.join(", ")}.`;
  throw new AwsUsageError(
    `${service} has no action "${action}".${hint} aws_api_docs with service "${service}" lists them all.`,
  );
}

export function modelRequest(
  model: ServiceModel,
  action: string,
  params: Params,
  region: string,
): AwsRequest {
  if (!NAME.test(action)) throw new AwsUsageError(`"${action}" is not an AWS action name.`);
  const op = operationOf(model, model.service, action);
  return withHostPrefix(byProtocol(model, op, params, region), op, params);
}

function byProtocol(
  model: ServiceModel,
  op: Operation,
  params: Params,
  region: string,
): AwsRequest {
  const meta = model.metadata;
  const global =
    meta.globalEndpoint !== undefined && meta.endpointPrefix !== "s3"
      ? { host: meta.globalEndpoint, region: "us-east-1" }
      : undefined;
  const common = {
    signing: meta.signingName ?? meta.endpointPrefix,
    host: meta.endpointPrefix,
    ...(global === undefined ? {} : { global }),
  };
  const protocol = protocolOf(model);
  if (protocol === "query" || protocol === "ec2") {
    const def = { protocol: "query" as const, ...common, version: meta.apiVersion ?? "" };
    return queryRequest({ ...def, ec2: protocol === "ec2" }, op.name, params, region);
  }
  if (protocol === "json") {
    const json: JsonService["json"] = meta.jsonVersion === "1.1" ? "1.1" : "1.0";
    const def = { protocol: "json" as const, ...common, json, target: meta.targetPrefix ?? "" };
    return jsonRequest(def, op.name, params, region);
  }
  if (protocol === "rest-json" || protocol === "rest-xml") {
    return restRequest(model, op, params, global ?? hostOf(meta.endpointPrefix, region));
  }
  throw new AwsUsageError(
    `${model.service} speaks ${meta.protocols?.join(", ") ?? meta.protocol}, which aws_api cannot send.`,
  );
}

function hostOf(prefix: string, region: string): { host: string; region: string } {
  return { host: `${prefix}.${region}.amazonaws.com`, region };
}

/** An operation's own host label (`data-`, `{AccountId}.`) in front of the host. */
function withHostPrefix(request: AwsRequest, op: Operation, params: Params): AwsRequest {
  const prefix = op.endpoint?.hostPrefix;
  if (prefix === undefined || prefix === "") return request;
  const label = prefix.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (typeof value !== "string" || !/^[A-Za-z0-9-]+$/.test(value)) {
      throw new AwsUsageError(`${op.name} needs "${name}" in params (letters, digits, dashes).`);
    }
    return value;
  });
  const url = new URL(request.url);
  url.hostname = `${label}${url.hostname}`;
  return { ...request, url: url.toString() };
}

function shapeOf(model: ServiceModel, name: string): Shape {
  return model.shapes[name] ?? { type: "string" };
}

/** A URI label's value: every character escaped, but a greedy label (`{Key+}`) keeps its slashes. */
function uriValue(value: unknown, greedy: boolean): string {
  const text = scalar(value);
  return greedy ? text.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(text);
}

type Parts = {
  query: string[];
  headers: Record<string, string>;
  body: Params;
  labels: Record<string, string>;
};

function pair(name: string, value: unknown): string {
  return `${encodeURIComponent(name)}=${encodeURIComponent(scalar(value))}`;
}

/** Where each member given goes: the URI, the query, a header or the body. */
function place(model: ServiceModel, input: Shape, params: Params): Parts {
  const parts: Parts = { query: [], headers: {}, body: {}, labels: {} };
  for (const [name, member] of Object.entries(input.members ?? {})) {
    const value = params[name];
    if (value === undefined || value === null || name === input.payload) continue;
    placeOne(model, parts, name, member, value);
  }
  return parts;
}

function placeOne(
  model: ServiceModel,
  parts: Parts,
  name: string,
  member: Member,
  value: unknown,
): void {
  const wire = member.locationName ?? name;
  if (member.location === "uri") parts.labels[wire] = scalar(value);
  else if (member.location === "querystring") placeQuery(model, parts, wire, member, value);
  else if (member.location === "header" || member.location === "headers") {
    placeHeader(parts, wire, member, value);
  }
  // Kept by the member's own name; the body's writer spells it.
  else parts.body[name] = value;
}

function placeQuery(
  model: ServiceModel,
  parts: Parts,
  wire: string,
  member: Member,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    for (const each of value) parts.query.push(pair(wire, each));
  } else if (shapeOf(model, member.shape).type === "map" && typeof value === "object") {
    for (const [key, each] of Object.entries(value as Params)) parts.query.push(pair(key, each));
  } else parts.query.push(pair(wire, value));
}

/** A `header` member, or a `headers` map whose keys follow the member's prefix (`x-amz-meta-`). */
function placeHeader(parts: Parts, wire: string, member: Member, value: unknown): void {
  if (member.location === "headers" && typeof value === "object" && value !== null) {
    for (const [key, each] of Object.entries(value as Params)) {
      parts.headers[`${wire}${key}`.toLowerCase()] = scalar(each);
    }
    return;
  }
  parts.headers[wire.toLowerCase()] = Array.isArray(value)
    ? value.map(scalar).join(",")
    : scalar(value);
}

function required(op: Operation, input: Shape, params: Params): void {
  const missing = (input.required ?? []).filter(
    (name) => params[name] === undefined || params[name] === null,
  );
  if (missing.length > 0) {
    throw new AwsUsageError(
      `${op.name} needs ${missing.map((m) => `"${m}"`).join(", ")} in params.`,
    );
  }
}

/** The path with its labels filled in, and the fixed query of the request URI (`?tagging`). */
function pathOf(op: Operation, labels: Record<string, string>): { path: string; fixed: string[] } {
  const uri = op.http?.requestUri ?? "/";
  const [template = "/", fixed = ""] = uri.split("?", 2);
  const path = template.replace(/\{([^}+]+)(\+?)\}/g, (_, name: string, greedy: string) => {
    const value = labels[name];
    if (value === undefined) throw new AwsUsageError(`${op.name} needs "${name}" in params.`);
    return uriValue(value, greedy === "+");
  });
  return { path, fixed: fixed === "" ? [] : fixed.split("&") };
}

type Body = { body?: string; type?: string };

/** The body and its content type: the payload member, or the members left over. */
function bodyOf(
  model: ServiceModel,
  op: Operation,
  input: Shape,
  params: Params,
  body: Params,
): Body {
  const xml = protocolOf(model) === "rest-xml";
  if (input.payload !== undefined) return payloadBody(model, input, input.payload, params, xml);
  if (Object.keys(body).length === 0) {
    const hasBodyMembers = Object.values(input.members ?? {}).some((m) => m.location === undefined);
    const sends = !["GET", "HEAD", "DELETE"].includes(op.http?.method ?? "");
    return !xml && hasBodyMembers && sends ? { body: "{}", type: "application/json" } : {};
  }
  if (xml) {
    const name = op.input?.locationName ?? input.locationName ?? op.input?.shape ?? op.name;
    const root = xmlOf(model, name, op.input?.shape ?? "", body, op.input?.xmlNamespace?.uri);
    return { body: root, type: "application/xml" };
  }
  // rest-json spells a body member by its locationName where it has one.
  const spelled = Object.entries(body).map(([key, value]) => [
    input.members?.[key]?.locationName ?? key,
    value,
  ]);
  return { body: JSON.stringify(Object.fromEntries(spelled)), type: "application/json" };
}

/** The payload member as the whole body: as it is for a blob or string, else JSON or XML. */
function payloadBody(
  model: ServiceModel,
  input: Shape,
  payload: string,
  params: Params,
  xml: boolean,
): Body {
  const member = input.members?.[payload];
  const value = params[payload];
  if (member === undefined || value === undefined || value === null) return {};
  const type = shapeOf(model, member.shape).type;
  if (type === "blob" || type === "string") {
    return { body: typeof value === "string" ? value : JSON.stringify(value) };
  }
  if (!xml) return { body: JSON.stringify(value), type: "application/json" };
  const root = member.locationName ?? payload;
  return {
    body: xmlOf(model, root, member.shape, value, member.xmlNamespace?.uri),
    type: "application/xml",
  };
}

/** `value` as the element `name` of shape `shapeName`, with `xmlns` on the root when given. */
export function xmlOf(
  model: ServiceModel,
  name: string,
  shapeName: string,
  value: unknown,
  namespace?: string,
): string {
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) {
    throw new AwsUsageError(`"${name}" cannot be an XML element name.`);
  }
  const ns = namespace === undefined ? "" : ` xmlns="${escapeXml(namespace)}"`;
  return `<${name}${ns}>${xmlInside(model, shapeOf(model, shapeName), value)}</${name}>`;
}

function xmlInside(model: ServiceModel, shape: Shape, value: unknown): string {
  if (shape.type === "structure" && typeof value === "object" && value !== null) {
    return Object.entries(value as Params)
      .map(([key, inside]) => {
        const member = shape.members?.[key];
        if (member === undefined) return xmlOf(model, key, "", inside);
        return xmlMember(model, member.locationName ?? key, member, inside);
      })
      .join("");
  }
  if (shape.type === "list" && Array.isArray(value) && shape.member !== undefined) {
    const item = shape.member;
    return value
      .map((each) => xmlOf(model, item.locationName ?? "member", item.shape, each))
      .join("");
  }
  if (shape.type === "map" && typeof value === "object" && value !== null) {
    return Object.entries(value as Params)
      .map(
        ([key, each]) =>
          `<entry><key>${escapeXml(key)}</key>${xmlOf(model, "value", shape.value?.shape ?? "", each)}</entry>`,
      )
      .join("");
  }
  return escapeXml(scalar(value));
}

/** A member: a flattened list repeats its items under the member's own name. */
function xmlMember(model: ServiceModel, name: string, member: Member, value: unknown): string {
  const shape = shapeOf(model, member.shape);
  if (shape.type === "list" && (member.flattened || shape.flattened) && Array.isArray(value)) {
    const item = shape.member?.shape ?? "";
    return value.map((each) => xmlOf(model, name, item, each)).join("");
  }
  return xmlOf(model, name, member.shape, value, member.xmlNamespace?.uri);
}

/** A bucket's host when its name allows (no dots, lower case), else null: path style. */
function bucketHost(bucket: unknown, host: string): string | null {
  return typeof bucket === "string" && /^[a-z0-9][a-z0-9-]*$/.test(bucket)
    ? `${bucket}.${host}`
    : null;
}

function restRequest(
  model: ServiceModel,
  op: Operation,
  params: Params,
  where: { host: string; region: string },
): AwsRequest {
  const input =
    op.input === undefined ? ({ type: "structure" } as Shape) : shapeOf(model, op.input.shape);
  required(op, input, params);
  const parts = place(model, input, params);
  const { path: filled, fixed } = pathOf(op, parts.labels);
  let path = filled;
  let host = where.host;
  const template = op.http?.requestUri ?? "";
  const virtual =
    model.metadata.endpointPrefix === "s3" && template.startsWith("/{Bucket}")
      ? bucketHost(params["Bucket"], host)
      : null;
  if (virtual !== null) {
    host = virtual;
    path = path.slice(`/${encodeURIComponent(String(params["Bucket"]))}`.length) || "/";
  }
  const query = [...fixed, ...parts.query];
  const { body, type } = bodyOf(model, op, input, params, parts.body);
  const headers = { ...parts.headers };
  if (body !== undefined && type !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = type;
  }
  if (body !== undefined && (op.httpChecksumRequired || op.httpChecksum?.requestChecksumRequired)) {
    headers["content-md5"] = createHash("md5").update(body).digest("base64");
  }
  return {
    url: `https://${host}${path}${query.length === 0 ? "" : `?${query.join("&")}`}`,
    method: op.http?.method ?? "POST",
    headers,
    ...(body === undefined ? {} : { body }),
    region: where.region,
    service: model.metadata.signingName ?? model.metadata.endpointPrefix,
  };
}
