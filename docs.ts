/**
 * `aws_api_docs`'s words, from a botocore model: a service's protocol and
 * operations, or one operation's request — how it is sent, which parameters
 * it needs, its input and output shapes a few levels deep — with the HTML of
 * AWS's documentation stripped and every part trimmed, the whole capped at
 * about 40 kB.
 */

import { judge } from "./allowlist";
import { type Member, type Operation, protocolOf, type ServiceModel, type Shape } from "./models";

export const MAX_DOCS = 40_000;
/** How deep the input and output shapes are written out. */
export const DEPTH = 4;
const OPERATION_DOC = 1_500;
const MEMBER_DOC = 160;
const SERVICE_DOC = 600;
const ENUM_SHOWN = 8;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/** `html` as plain text on one line, cut to `max` characters with "…". */
export function stripHtml(html: string | undefined, max: number): string {
  const text = (html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** `text` cut to the cap, saying so. */
export function capped(text: string): string {
  if (text.length <= MAX_DOCS) return text;
  return `${text.slice(0, MAX_DOCS)}\n\n[Cut at ${MAX_DOCS} of ${text.length} characters.]`;
}

function header(model: ServiceModel): string {
  const meta = model.metadata;
  return [
    `${model.service}${meta.serviceFullName === undefined ? "" : ` (${meta.serviceFullName})`}`,
    `protocol ${protocolOf(model) ?? meta.protocols?.join("/") ?? meta.protocol}`,
    `API version ${meta.apiVersion ?? model.version}`,
    `endpoint prefix ${meta.endpointPrefix}`,
    `signing name ${meta.signingName ?? meta.endpointPrefix}`,
  ].join(" · ");
}

/** A service: its protocol, endpoint prefix, API version and the names of its operations. */
export function serviceDocs(model: ServiceModel): string {
  const names = Object.keys(model.operations).sort();
  const about = stripHtml(model.documentation, SERVICE_DOC);
  return capped(
    [
      header(model),
      ...(about === "" ? [] : [about]),
      `Operations (${names.length}): ${names.join(", ")}`,
      `For one of them: aws_api_docs with service "${model.service}" and its action.`,
    ].join("\n\n"),
  );
}

/** How `aws_api` sends the operation, in one line. */
function wire(model: ServiceModel, op: Operation): string {
  const protocol = protocolOf(model);
  const meta = model.metadata;
  if (protocol === "json") {
    return `POST, X-Amz-Target ${meta.targetPrefix}.${op.name}, application/x-amz-json-${meta.jsonVersion ?? "1.0"}; params are the JSON body.`;
  }
  if (protocol === "query" || protocol === "ec2") {
    const lists = protocol === "ec2" ? "Name.1" : "Name.member.1";
    return `POST form Action=${op.name}&Version=${meta.apiVersion}; params flatten (lists as ${lists}, objects as Parent.Child).`;
  }
  return `${op.http?.method ?? "POST"} ${op.http?.requestUri ?? "/"}; each param goes where its [location] says, the rest into the body.`;
}

function verdict(model: ServiceModel, op: Operation): string {
  const judged = judge(model.service, op.name);
  if (judged.kind === "read") return "a read: aws_api runs it at once.";
  if (judged.kind === "write") return "a write: aws_api asks the reader on a confirm card first.";
  return `refused by aws_api (${judged.message})`;
}

/** One operation: how it is sent, what it needs, its input and output shapes. */
export function actionDocs(model: ServiceModel, op: Operation): string {
  const input = op.input === undefined ? undefined : model.shapes[op.input.shape];
  const lines = [
    `${model.service} ${op.name}${op.deprecated ? " (deprecated)" : ""}`,
    header(model),
    `Request: ${wire(model, op)}`,
    `In aws_api: ${verdict(model, op)}`,
    `Required params: ${input?.required?.join(", ") || "none"}`,
  ];
  if (input?.payload !== undefined) lines.push(`Payload (the whole body): ${input.payload}`);
  const about = stripHtml(op.documentation, OPERATION_DOC);
  if (about !== "") lines.push(`About: ${about}`);
  // A big operation (ec2 RunInstances) is written less deep until it fits, so its output shows too.
  let shapes = "";
  for (let depth = DEPTH; depth >= 1; depth -= 1) {
    shapes = shapesText(model, op, depth);
    if (lines.join("\n").length + shapes.length <= MAX_DOCS) break;
  }
  return capped(`${lines.join("\n")}\n${shapes}`);
}

/** The input and output shapes, `depth` levels deep. */
function shapesText(model: ServiceModel, op: Operation, depth: number): string {
  const lines = ["", `Input${op.input === undefined ? ": none" : ` (${op.input.shape}):`}`];
  if (op.input !== undefined) {
    lines.push(...members(model, op.input.shape, 1, [op.input.shape], depth));
  }
  lines.push("", `Output${op.output === undefined ? ": none" : ` (${op.output.shape}):`}`);
  if (op.output !== undefined) {
    lines.push(...members(model, op.output.shape, 1, [op.output.shape], depth));
  }
  return lines.join("\n");
}

/** The type of a shape in a few characters: `string`, `list<Filter>`, `map<string, Tag>`. */
function typeOf(model: ServiceModel, name: string): string {
  const shape = model.shapes[name];
  if (shape === undefined) return name;
  if (shape.type === "structure") return name;
  if (shape.type === "list") return `list<${typeOf(model, shape.member?.shape ?? "")}>`;
  if (shape.type === "map") {
    return `map<${typeOf(model, shape.key?.shape ?? "")}, ${typeOf(model, shape.value?.shape ?? "")}>`;
  }
  return shape.type;
}

function enumOf(shape: Shape | undefined): string {
  const values = shape?.enum;
  if (values === undefined || values.length === 0) return "";
  const shown = values.slice(0, ENUM_SHOWN).join("|");
  return ` one of ${shown}${values.length > ENUM_SHOWN ? "|…" : ""}`;
}

function locationOf(member: Member): string {
  if (member.location === undefined) return "";
  return ` [${member.location}${member.locationName === undefined ? "" : `: ${member.locationName}`}]`;
}

/** The structure a shape leads to when written out: itself, a list's item or a map's value. */
function inner(model: ServiceModel, name: string): string | null {
  const shape = model.shapes[name];
  if (shape === undefined) return null;
  if (shape.type === "structure") return name;
  if (shape.type === "list") return inner(model, shape.member?.shape ?? "");
  if (shape.type === "map") return inner(model, shape.value?.shape ?? "");
  return null;
}

/** The members of structure `name`, one line each, nested ones indented below, `most` levels at most. */
function members(
  model: ServiceModel,
  name: string,
  depth: number,
  path: string[],
  most: number,
): string[] {
  const shape = model.shapes[name];
  const required = new Set(shape?.required ?? []);
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const [key, member] of Object.entries(shape?.members ?? {})) {
    const doc = stripHtml(member.documentation, MEMBER_DOC);
    lines.push(
      `${indent}${key}${required.has(key) ? " (required)" : ""}: ${typeOf(model, member.shape)}${locationOf(member)}${enumOf(model.shapes[member.shape])}${doc === "" ? "" : ` — ${doc}`}`,
    );
    const next = inner(model, member.shape);
    if (next === null) continue;
    if (path.includes(next)) lines.push(`${indent}  (${next}, as above)`);
    else if (depth >= most) lines.push(`${indent}  (${next}: deeper than ${most} levels)`);
    else lines.push(...members(model, next, depth + 1, [...path, next], most));
  }
  return lines;
}
