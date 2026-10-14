import { expect, test } from "bun:test";
import { actionDocs, capped, MAX_DOCS, serviceDocs, stripHtml } from "../docs";
import type { ServiceModel } from "../models";
import { MODELS } from "./fake-models";

function model(name: string): ServiceModel {
  const found = MODELS[name];
  if (found === undefined) throw new Error(name);
  return {
    ...(found.model as Omit<ServiceModel, "service" | "version">),
    service: name,
    version: found.version,
  };
}

function op(m: ServiceModel, name: string) {
  const found = m.operations[name];
  if (found === undefined) throw new Error(name);
  return found;
}

test("stripHtml drops tags and entities, folds whitespace and cuts with an ellipsis", () => {
  expect(stripHtml("<p>A &amp; <code>B</code></p>\n\n<p>C</p>", 100)).toBe("A & B C");
  expect(stripHtml("<p>abcdefghij</p>", 6)).toBe("abcde…");
  expect(stripHtml(undefined, 10)).toBe("");
});

test("a service: protocol, endpoint prefix, API version, stripped docs and the operation names", () => {
  const out = serviceDocs(model("s3"));
  expect(out).toContain("s3 (Amazon Simple Storage Service)");
  expect(out).toContain("protocol rest-xml");
  expect(out).toContain("API version 2006-03-01");
  expect(out).toContain("endpoint prefix s3");
  expect(out).toContain("Amazon S3 stores objects.");
  expect(out).not.toContain("<b>");
  expect(out).toContain("Operations (3): GetObject, ListObjectsV2, PutBucketTagging");
});

test("an action: method and URI, required params, input and output with locations and enums", () => {
  const s3 = model("s3");
  const out = actionDocs(s3, op(s3, "ListObjectsV2"));
  expect(out).toContain("Request: GET /{Bucket}?list-type=2");
  expect(out).toContain("a read: aws_api runs it at once.");
  expect(out).toContain("Required params: Bucket");
  expect(out).toContain("  Bucket (required): string [uri: Bucket]");
  expect(out).toContain(
    "  Prefix: string [querystring: prefix] — Limits the response to keys that begin with the prefix.",
  );
  expect(out).toContain("Output (ListObjectsV2Output):");
  expect(out).toContain("  Contents: list<Object>");
  expect(out).toContain("    Key: string");
  expect(out).toContain(
    "    StorageClass: string one of STANDARD|REDUCED_REDUNDANCY|GLACIER|STANDARD_IA|ONEZONE_IA|INTELLIGENT_TIERING|DEEP_ARCHIVE|OUTPOSTS|…",
  );
});

test("a write names its payload and that it asks; long docs are trimmed", () => {
  const s3 = model("s3");
  const out = actionDocs(s3, op(s3, "PutBucketTagging"));
  expect(out).toContain("Request: PUT /{Bucket}?tagging");
  expect(out).toContain("a write: aws_api asks the reader on a confirm card first.");
  expect(out).toContain("Payload (the whole body): Tagging");
  const about = out.split("\n").find((line) => line.startsWith("About: ")) ?? "";
  expect(about.length).toBeLessThanOrEqual("About: ".length + 1_500);
  expect(about).toEndWith("…");
  expect(about).not.toContain("<p>");
});

test("shapes stop at a shape already above them and below four levels", () => {
  const deep = model("deep");
  const out = actionDocs(deep, op(deep, "GetTree"));
  expect(out).toContain("  Children: list<Node>");
  expect(out).toContain("    (Node, as above)");
  expect(out).toContain("(L5: deeper than 4 levels)");
  expect(out).not.toContain("Leaf");
});

test("an operation too big at four levels is written less deep, so its output still shows", () => {
  const doc = `<p>${"word ".repeat(40)}</p>`;
  const leaf = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`Leaf${i}`, { shape: "Text", documentation: doc }]),
  );
  const top = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`Part${i}`, { shape: "Inner", documentation: doc }]),
  );
  const big: ServiceModel = {
    service: "big",
    version: "2020-01-01",
    metadata: { endpointPrefix: "big", protocol: "json", targetPrefix: "Big" },
    operations: { RunBig: { name: "RunBig", input: { shape: "Top" }, output: { shape: "Out" } } },
    shapes: {
      Text: { type: "string" },
      Inner: { type: "structure", members: leaf },
      Top: { type: "structure", members: top },
      Out: { type: "structure", members: { Done: { shape: "Text" } } },
    },
  };
  const out = actionDocs(big, op(big, "RunBig"));
  expect(out.length).toBeLessThanOrEqual(MAX_DOCS);
  expect(out).toContain("(Inner: deeper than 1 levels)");
  expect(out).toContain("Output (Out):\n  Done: string");
});

test("the whole is capped at about 40 kB, saying so", () => {
  const out = capped("x".repeat(MAX_DOCS + 5_000));
  expect(out.length).toBeLessThan(MAX_DOCS + 100);
  expect(out).toContain(`[Cut at ${MAX_DOCS} of ${MAX_DOCS + 5_000} characters.]`);
});
