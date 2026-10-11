import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionTool } from "@prifly/extension-api";
import { Accounts } from "../accounts";
import { REDACTED } from "../allowlist";
import { CallLog } from "../calls";
import { CostStore } from "../cost";
import { awsTools, MAX_REPLY } from "../tools";
import { type Canned, fakeAws, IDENTITY, json, KEY, SECOND, xml } from "./fake-aws";

let folder = "";
let clock = Date.parse("2026-10-11T12:00:00Z");
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aws-ext-"));
  clock = Date.parse("2026-10-11T12:00:00Z");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function setup(table: Record<string, Canned>, accounts = [KEY]) {
  const fake = fakeAws(table, accounts);
  const now = () => clock;
  const accountsOf = new Accounts(() => fake.connections, now);
  const calls = new CallLog(folder, now);
  const cost = new CostStore(folder, accountsOf);
  const tools = awsTools({ accounts: accountsOf, calls, cost, now });
  const tool = (name: string): ExtensionTool => {
    const found = tools.find((each) => each.name === name);
    if (found === undefined) throw new Error(name);
    return found;
  };
  const call = (name: string, args: Record<string, unknown>) =>
    tool(name).call(args, {
      session: "4e1c90ab-1111",
      pick: async () => null,
      signal: new AbortController().signal,
      scratchpad: folder,
    });
  return { fake, calls, cost, call, tools };
}

const INSTANCES = xml("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>");

test("the tools are aws_whoami, aws_call and aws_cost", () => {
  expect(setup({}).tools.map((tool) => tool.name)).toEqual(["aws_whoami", "aws_call", "aws_cost"]);
});

test("aws_whoami gives each key's account, state and identity", async () => {
  const { call } = setup({ "sts:GetCallerIdentity": IDENTITY }, [KEY, SECOND]);
  const rows = JSON.parse(await call("aws_whoami", {}));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    connection: "aws-1",
    account: "artemis-prod",
    accountId: "4821-0937-1150",
    state: "ok",
    identity: "user/prifly",
  });
});

test("aws_whoami says so when no key is filed", async () => {
  expect(await setup({}, []).call("aws_whoami", {})).toContain("No AWS key is filed yet");
});

test("aws_call reads: the right request goes out, the reply comes back as text, the call is logged", async () => {
  const { call, fake, calls } = setup({ "ec2:DescribeInstances": INSTANCES });
  const out = await call("aws_call", {
    service: "ec2",
    action: "DescribeInstances",
    params: { "InstanceId.1": "i-1" },
  });
  expect(out).toBe("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>");
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]).toMatchObject({
    connection: "aws-1",
    url: "https://ec2.eu-north-1.amazonaws.com/",
    method: "POST",
    region: "eu-north-1",
    service: "ec2",
    body: "Action=DescribeInstances&Version=2016-11-15&InstanceId.1=i-1",
  });
  // prifly signs: the plugin sends no bearer token.
  expect(fake.requests[0]?.headers.get("Authorization")).toBeNull();
  expect(calls.all()).toMatchObject([
    {
      session: "4e1c90ab-1111",
      account: "artemis-prod",
      service: "ec2",
      action: "DescribeInstances",
      region: "eu-north-1",
      kind: "read",
      outcome: "Read",
    },
  ]);
});

test("aws_call takes a region and an account by id, account id or alias", async () => {
  const table = { "ec2:DescribeInstances": INSTANCES };
  for (const account of ["aws-2", "2290-4471-8836", "229044718836", "Morpheus-Sandbox"]) {
    const { call, fake } = setup(table, [KEY, SECOND]);
    await call("aws_call", {
      service: "ec2",
      action: "DescribeInstances",
      region: "eu-west-1",
      account,
    });
    expect(fake.sent[0]).toMatchObject({ connection: "aws-2", region: "eu-west-1" });
  }
  const { call, fake } = setup(table, [KEY, SECOND]);
  await call("aws_call", { service: "ec2", action: "DescribeInstances" });
  expect(fake.sent[0]?.connection).toBe("aws-1");
  expect(
    await call("aws_call", { service: "ec2", action: "DescribeInstances", account: "nope" }),
  ).toContain('No AWS key matches "nope"');
});

test("aws_call refuses a write: nothing is sent, the rule is named, the log says Refused: read-only", async () => {
  const { call, fake, calls } = setup({});
  const out = await call("aws_call", {
    service: "ec2",
    action: "TerminateInstances",
    params: { "InstanceId.1": "i-1" },
  });
  expect(out).toStartWith("Refused: read-only.");
  expect(out).toContain("read-only in v1");
  expect(fake.sent).toHaveLength(0);
  expect(calls.all()).toMatchObject([
    { action: "TerminateInstances", kind: "refused", outcome: "Refused: read-only" },
  ]);
});

test("aws_call refuses a secret read and a Cost Explorer call", async () => {
  const { call, fake, calls } = setup({});
  expect(
    await call("aws_call", {
      service: "secretsmanager",
      action: "GetSecretValue",
      params: { SecretId: "x" },
    }),
  ).toStartWith("Refused: would reveal a secret.");
  expect(
    await call("aws_call", { service: "ce", action: "GetCostAndUsage", params: {} }),
  ).toStartWith("Refused: costs money.");
  expect(await call("aws_call", { service: "sts", action: "AssumeRole" })).toStartWith(
    "Refused: would reveal a secret.",
  );
  expect(fake.sent).toHaveLength(0);
  expect(calls.all().map((entry) => entry.outcome)).toEqual([
    "Refused: would reveal a secret",
    "Refused: costs money",
    "Refused: would reveal a secret",
  ]);
});

test("aws_call refuses with no key filed or an unknown service, but still logs it", async () => {
  expect(
    await setup({}, []).call("aws_call", { service: "ec2", action: "DescribeInstances" }),
  ).toContain("No AWS key is filed yet");
  rmSync(folder, { recursive: true, force: true });
  const { call, calls } = setup({});
  const out = await call("aws_call", { service: "kinesis", action: "ListStreams" });
  expect(out).toContain("Unknown service");
  expect(out).toContain("Supported services:");
  expect(calls.all()).toMatchObject([{ kind: "failed", outcome: "Failed: not supported" }]);
});

test("aws_call redacts Lambda environment values", async () => {
  const { call } = setup({
    "lambda:ListFunctions": json({
      Functions: [{ FunctionName: "api", Environment: { Variables: { DB_PASSWORD: "hunter2" } } }],
    }),
  });
  const out = await call("aws_call", { service: "lambda", action: "ListFunctions" });
  expect(out).not.toContain("hunter2");
  expect(out).toContain("DB_PASSWORD");
  expect(out).toContain(REDACTED);
});

test("aws_call trims a long reply to about 40 kB and names the token to page on", async () => {
  const big = `<DescribeInstancesResponse>${"<x>0123456789</x>".repeat(4000)}<nextToken>tok-123</nextToken></DescribeInstancesResponse>`;
  const { call } = setup({ "ec2:DescribeInstances": xml(big) });
  const out = await call("aws_call", { service: "ec2", action: "DescribeInstances" });
  expect(out.length).toBeLessThan(MAX_REPLY + 400);
  expect(out).toContain(`Cut at ${MAX_REPLY} of ${big.length} characters`);
  expect(out).toContain("NextToken=tok-123");
});

test("a short reply with a next page names the Marker or NextToken too", async () => {
  const { call } = setup({
    "iam:ListUsers": xml("<r><IsTruncated>true</IsTruncated><Marker>m-1</Marker></r>"),
    "logs:DescribeLogGroups": json({ logGroups: [], nextToken: "n-2" }),
  });
  expect(await call("aws_call", { service: "iam", action: "ListUsers" })).toContain("Marker=m-1");
  expect(await call("aws_call", { service: "logs", action: "DescribeLogGroups" })).toContain(
    "nextToken=n-2",
  );
});

test("a key AWS no longer accepts comes back as text for the reader to re-check or re-add", async () => {
  const { call, fake, calls } = setup({ "ec2:DescribeInstances": INSTANCES });
  fake.endpoint.revoke("aws-1");
  const out = await call("aws_call", { service: "ec2", action: "DescribeInstances" });
  expect(out).toContain("Vault → Connections");
  expect(out).toContain("re-check or re-add");
  expect(calls.all()).toMatchObject([{ kind: "sign-in", outcome: "Key needs signing in" }]);
});

test("an AWS error comes back as a sentence with its code, and is logged as failed", async () => {
  const { call, calls } = setup({
    "ec2:DescribeInstances": xml(
      "<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>not allowed</Message></Error></Errors></Response>",
      403,
    ),
  });
  const out = await call("aws_call", { service: "ec2", action: "DescribeInstances" });
  expect(out).toContain("UnauthorizedOperation: not allowed");
  expect(calls.all()).toMatchObject([{ kind: "failed", outcome: "Failed: UnauthorizedOperation" }]);
});

test("aws_cost reads what was kept and never calls Cost Explorer", async () => {
  const { call, fake } = setup({});
  expect(await call("aws_cost", {})).toContain("has not read this one");
  expect(fake.sent).toHaveLength(0);
});

test("the call log keeps 30 days", () => {
  const log = new CallLog(folder, () => clock);
  const entry = {
    session: "s",
    account: "a",
    service: "ec2",
    action: "DescribeRegions",
    region: "r",
    kind: "read" as const,
    outcome: "Read",
  };
  log.append({ ...entry, at: new Date(clock - 31 * 86_400_000).toISOString() });
  clock += 2 * 3_600_000;
  log.append({ ...entry, at: new Date(clock - 86_400_000).toISOString() });
  clock += 2 * 3_600_000;
  log.append({ ...entry, at: new Date(clock).toISOString() });
  expect(log.all()).toHaveLength(2);
});
