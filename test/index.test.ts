import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate } from "../index";
import { fakeApi } from "./fake-api";
import { fakeAws, IDENTITY, KEY, SECOND, xml } from "./fake-aws";

const ROOT = join(import.meta.dir, "..");
let folder = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aws-ext-"));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

/** Wait for the status line the background read sets. */
async function statusOf(statuses: string[]): Promise<string> {
  for (let tries = 0; tries < 100 && statuses.length === 0; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return statuses.at(-1) ?? "";
}

test("the manifest has no launch entry, and the code calls neither show nor flag", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "prifly-extension.json"), "utf8"));
  expect(manifest.launch).toBeUndefined();
  for (const file of readdirSync(ROOT).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).not.toMatch(/api\.(show|flag)\b/);
  }
});

test("activate registers the tools, shows nothing and sets the status line from whoami", async () => {
  const aws = fakeAws({ "sts:GetCallerIdentity": IDENTITY });
  const fake = fakeApi({ connections: aws.connections, folder });
  const stop = activate(fake.api);
  try {
    expect(await statusOf(fake.statuses)).toBe("Connected · account 482109371150 (prifly)");
    expect(fake.tools().map((tool) => tool.name)).toEqual([
      "aws_whoami",
      "aws_api",
      "aws_api_docs",
      "aws_cost",
    ]);
    expect(fake.shown).toHaveLength(0);
    expect(fake.flags.size).toBe(0);
  } finally {
    stop();
  }
});

test("the status line with two keys, no key, and a key that needs signing in", async () => {
  const two = fakeApi({
    connections: fakeAws({ "sts:GetCallerIdentity": IDENTITY }, [KEY, SECOND]).connections,
    folder,
  });
  const stopTwo = activate(two.api);
  expect(await statusOf(two.statuses)).toBe("Connected · account 482109371150 (prifly) · 2 keys");
  stopTwo();

  const none = fakeApi({ connections: fakeAws({}, []).connections, folder });
  const stopNone = activate(none.api);
  expect(await statusOf(none.statuses)).toBe("No AWS key filed · add one in Vault → Connections");
  stopNone();

  const revoked = fakeAws({ "sts:GetCallerIdentity": IDENTITY });
  revoked.endpoint.revoke("aws-1");
  const signIn = fakeApi({ connections: revoked.connections, folder });
  const stopSignIn = activate(signIn.api);
  expect(await statusOf(signIn.statuses)).toBe(
    "AWS key needs signing in · re-add it in Vault → Connections",
  );
  stopSignIn();
});

test("a write through the activated tools goes through api.confirm; a cancel sends nothing", async () => {
  const aws = fakeAws({
    "sts:GetCallerIdentity": IDENTITY,
    "ec2:StopInstances": xml("<StopInstancesResponse/>"),
  });
  const fake = fakeApi({ connections: aws.connections, folder, confirm: () => false });
  const stop = activate(fake.api);
  try {
    await statusOf(fake.statuses);
    const before = aws.sent.length;
    const out = await fake.callTool("aws_api", {
      service: "ec2",
      action: "StopInstances",
      params: { InstanceId: ["i-1"] },
    });
    expect(out).toBe("Not done: you cancelled");
    expect(fake.confirms).toHaveLength(1);
    expect(
      aws.sent.slice(before).filter((each) => each.body.includes("StopInstances")),
    ).toHaveLength(0);
  } finally {
    stop();
  }
});
