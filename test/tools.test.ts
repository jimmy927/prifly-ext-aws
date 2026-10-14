import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmSpec, ExtensionTool } from "@prifly/extension-api";
import { Accounts } from "../accounts";
import { REDACTED } from "../allowlist";
import { CostStore } from "../cost";
import { Models } from "../models";
import { awsTools, CANCELLED, MAX_REPLY } from "../tools";
import { type Canned, fakeAws, IDENTITY, json, KEY, SECOND, xml } from "./fake-aws";
import { fakeGithub } from "./fake-models";

let folder = "";
const clock = Date.parse("2026-10-11T12:00:00Z");
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aws-ext-"));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

type Options = { accounts?: (typeof KEY)[]; answer?: boolean | null };

/** The tools over a fake AWS and a fake GitHub; `answer` is the reader's click on each card (null: no `confirm` at all). */
function setup(table: Record<string, Canned>, options: Options = {}) {
  const fake = fakeAws(table, options.accounts ?? [KEY]);
  const github = fakeGithub();
  const accounts = new Accounts(
    () => fake.connections,
    () => clock,
    new Models(github.fetch),
  );
  const cost = new CostStore(folder, accounts);
  const confirms: ConfirmSpec[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const answer = options.answer === undefined ? true : options.answer;
  const tools = awsTools({
    accounts,
    cost,
    ...(answer === null
      ? {}
      : {
          confirm: async (spec: ConfirmSpec) => {
            confirms.push(spec);
            return answer;
          },
        }),
    log: (event, fields) => void logs.push({ event, fields }),
  });
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
  return { fake, github, confirms, logs, call, tools };
}

const INSTANCES = xml("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>");

test("the tools are aws_whoami, aws_api, aws_api_docs and aws_cost", () => {
  expect(setup({}).tools.map((tool) => tool.name)).toEqual([
    "aws_whoami",
    "aws_api",
    "aws_api_docs",
    "aws_cost",
  ]);
});

test("aws_whoami gives each key's account, state and identity", async () => {
  const { call } = setup({ "sts:GetCallerIdentity": IDENTITY }, { accounts: [KEY, SECOND] });
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
  expect(await setup({}, { accounts: [] }).call("aws_whoami", {})).toContain(
    "No AWS key is filed yet",
  );
});

test("a read runs at once, with no confirm card: the right request goes out, the reply comes back", async () => {
  const { call, fake, confirms, github } = setup({ "ec2:DescribeInstances": INSTANCES });
  const out = await call("aws_api", {
    service: "ec2",
    action: "DescribeInstances",
    params: { "InstanceId.1": "i-1" },
  });
  expect(out).toBe("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>");
  expect(confirms).toHaveLength(0);
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]).toMatchObject({
    connection: "aws-1",
    url: "https://ec2.eu-north-1.amazonaws.com/",
    method: "POST",
    region: "eu-north-1",
    service: "ec2",
    body: "Action=DescribeInstances&Version=2016-11-15&InstanceId.1=i-1",
  });
  // prifly signs: the plugin sends no bearer token. A table service needs no model.
  expect(fake.requests[0]?.headers.get("Authorization")).toBeNull();
  expect(github.urls).toHaveLength(0);
});

test("a read of a service off the table is built from its model, still without a card", async () => {
  const { call, fake, confirms } = setup({
    "GET my-bucket.s3.eu-north-1.amazonaws.com/": xml("<ListBucketResult/>"),
  });
  const out = await call("aws_api", {
    service: "s3",
    action: "ListObjectsV2",
    params: { Bucket: "my-bucket", Prefix: "logs/" },
  });
  expect(out).toBe("<ListBucketResult/>");
  expect(confirms).toHaveLength(0);
  expect(fake.sent[0]).toMatchObject({
    url: "https://my-bucket.s3.eu-north-1.amazonaws.com/?list-type=2&prefix=logs%2F",
    method: "GET",
    service: "s3",
    region: "eu-north-1",
  });
});

test("aws_api takes a region and an account by id, account id or alias", async () => {
  const table = { "ec2:DescribeInstances": INSTANCES };
  for (const account of ["aws-2", "2290-4471-8836", "229044718836", "Morpheus-Sandbox"]) {
    const { call, fake } = setup(table, { accounts: [KEY, SECOND] });
    await call("aws_api", {
      service: "ec2",
      action: "DescribeInstances",
      region: "eu-west-1",
      account,
    });
    expect(fake.sent[0]).toMatchObject({ connection: "aws-2", region: "eu-west-1" });
  }
  const { call, fake } = setup(table, { accounts: [KEY, SECOND] });
  await call("aws_api", { service: "ec2", action: "DescribeInstances" });
  expect(fake.sent[0]?.connection).toBe("aws-1");
  expect(
    await call("aws_api", { service: "ec2", action: "DescribeInstances", account: "nope" }),
  ).toContain('No AWS key matches "nope"');
});

test("a write asks first: the card shows service, action, region, account and the params", async () => {
  const { call, fake, confirms, logs } = setup({
    "ec2:TerminateInstances": xml("<TerminateInstancesResponse/>"),
  });
  const out = await call("aws_api", {
    service: "ec2",
    action: "TerminateInstances",
    params: { InstanceId: ["i-1"] },
  });
  expect(out).toBe("<TerminateInstancesResponse/>");
  expect(confirms).toHaveLength(1);
  const card = confirms[0] as ConfirmSpec;
  expect(card.title).toBe("AWS TerminateInstances");
  expect(card.summary).toBe(
    "ec2 TerminateInstances in eu-north-1 on artemis-prod (4821-0937-1150)",
  );
  expect(card.details).toContain("Service:  ec2");
  expect(card.details).toContain("Action:   TerminateInstances");
  expect(card.details).toContain("Region:   eu-north-1");
  expect(card.details).toContain("Account:  artemis-prod (4821-0937-1150)");
  expect(card.details).toContain(JSON.stringify({ InstanceId: ["i-1"] }, null, 2));
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]?.body).toBe("Action=TerminateInstances&Version=2016-11-15&InstanceId.1=i-1");
  expect(logs).toMatchObject([{ event: "write", fields: { action: "TerminateInstances" } }]);
});

test("a write the reader cancels makes no request and says so", async () => {
  const { call, fake, confirms } = setup(
    { "ec2:TerminateInstances": xml("<TerminateInstancesResponse/>") },
    { answer: false },
  );
  const out = await call("aws_api", {
    service: "ec2",
    action: "TerminateInstances",
    params: { InstanceId: ["i-1"] },
  });
  expect(out).toBe(CANCELLED);
  expect(out).toBe("Not done: you cancelled");
  expect(confirms).toHaveLength(1);
  expect(fake.sent).toHaveLength(0);
});

test("every kind of write asks, and a cancel sends nothing, REST and JSON alike", async () => {
  const writes = [
    { service: "s3", action: "PutBucketTagging", params: { Bucket: "b", Tagging: { TagSet: [] } } },
    { service: "lambda", action: "Invoke", params: { FunctionName: "api" } },
    { service: "kinesis", action: "DeleteStream", params: { StreamName: "s" } },
    { service: "dynamodb", action: "PutItem", params: { TableName: "t", Item: {} } },
  ];
  const { call, fake, confirms } = setup({}, { answer: false });
  for (const write of writes) expect(await call("aws_api", write)).toBe(CANCELLED);
  expect(confirms.map((card) => card.title)).toEqual([
    "AWS PutBucketTagging",
    "AWS Invoke",
    "AWS DeleteStream",
    "AWS PutItem",
  ]);
  expect(fake.sent).toHaveLength(0);
});

test("a write on a prifly with no confirm is not done", async () => {
  const { call, fake } = setup({}, { answer: null });
  const out = await call("aws_api", { service: "ec2", action: "RebootInstances" });
  expect(out).toStartWith("Not done:");
  expect(fake.sent).toHaveLength(0);
});

test("a REST write that is confirmed goes out with its body, method and checksum", async () => {
  const { call, fake } = setup({
    "PUT my-bucket.s3.eu-north-1.amazonaws.com/": new Response("", { status: 204 }),
  });
  const out = await call("aws_api", {
    service: "s3",
    action: "PutBucketTagging",
    params: { Bucket: "my-bucket", Tagging: { TagSet: [{ Key: "env", Value: "prod" }] } },
  });
  expect(out).toBe("AWS answered HTTP 204 with no body: done.");
  expect(fake.sent[0]).toMatchObject({
    method: "PUT",
    url: "https://my-bucket.s3.eu-north-1.amazonaws.com/?tagging",
    body: '<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag></TagSet></Tagging>',
  });
  expect(fake.requests[0]?.headers.get("content-md5")).toBeTruthy();
});

test("the secret-revealing calls stay refused, before any card and any request", async () => {
  const { call, fake, confirms } = setup({});
  const refused = [
    { service: "secretsmanager", action: "GetSecretValue", params: { SecretId: "x" } },
    { service: "ec2", action: "GetPasswordData", params: { InstanceId: "i-1" } },
    { service: "ecr", action: "GetAuthorizationToken" },
    { service: "sts", action: "AssumeRole", params: { RoleArn: "arn" } },
    { service: "ssm", action: "GetParameter", params: { Name: "/x", WithDecryption: true } },
    {
      service: "ec2",
      action: "DescribeInstanceAttribute",
      params: { InstanceId: "i-1", Attribute: "userData" },
    },
    { service: "iam", action: "CreateAccessKey", params: { UserName: "u" } },
  ];
  for (const each of refused) {
    expect(await call("aws_api", each)).toStartWith("Refused: would reveal a secret.");
  }
  expect(confirms).toHaveLength(0);
  expect(fake.sent).toHaveLength(0);
});

test("Cost Explorer is refused through aws_api, read or write", async () => {
  const { call, fake, confirms } = setup({});
  expect(await call("aws_api", { service: "ce", action: "GetCostAndUsage" })).toStartWith(
    "Refused: costs money.",
  );
  expect(
    await call("aws_api", { service: "ce", action: "CreateCostCategoryDefinition" }),
  ).toStartWith("Refused: costs money.");
  expect(confirms).toHaveLength(0);
  expect(fake.sent).toHaveLength(0);
});

test("no key filed, an unknown service or action: said in words, nothing sent", async () => {
  expect(
    await setup({}, { accounts: [] }).call("aws_api", {
      service: "ec2",
      action: "DescribeInstances",
    }),
  ).toContain("No AWS key is filed yet");
  const { call, fake, confirms } = setup({});
  expect(await call("aws_api", { service: "nosuch", action: "ListThings" })).toContain(
    'botocore has no AWS service "nosuch"',
  );
  expect(await call("aws_api", { service: "kinesis", action: "DeleteStreem" })).toContain(
    'kinesis has no action "DeleteStreem"',
  );
  expect(await call("aws_api", { service: "lambda", action: "Invoke", params: {} })).toContain(
    'Invoke needs "FunctionName"',
  );
  expect(confirms).toHaveLength(0);
  expect(fake.sent).toHaveLength(0);
});

test("aws_api redacts Lambda environment values", async () => {
  const { call } = setup({
    "GET lambda.eu-north-1.amazonaws.com/2015-03-31/functions/": json({
      Functions: [{ FunctionName: "api", Environment: { Variables: { DB_PASSWORD: "hunter2" } } }],
    }),
  });
  const out = await call("aws_api", { service: "lambda", action: "ListFunctions" });
  expect(out).not.toContain("hunter2");
  expect(out).toContain("DB_PASSWORD");
  expect(out).toContain(REDACTED);
});

test("aws_api trims a long reply to about 40 kB and names the token to page on", async () => {
  const big = `<DescribeInstancesResponse>${"<x>0123456789</x>".repeat(4000)}<nextToken>tok-123</nextToken></DescribeInstancesResponse>`;
  const { call } = setup({ "ec2:DescribeInstances": xml(big) });
  const out = await call("aws_api", { service: "ec2", action: "DescribeInstances" });
  expect(out.length).toBeLessThan(MAX_REPLY + 400);
  expect(out).toContain(`Cut at ${MAX_REPLY} of ${big.length} characters`);
  expect(out).toContain("NextToken=tok-123");
});

test("a short reply with a next page names the Marker or NextToken too", async () => {
  const { call } = setup({
    "iam:ListUsers": xml("<r><IsTruncated>true</IsTruncated><Marker>m-1</Marker></r>"),
    "logs:DescribeLogGroups": json({ logGroups: [], nextToken: "n-2" }),
  });
  expect(await call("aws_api", { service: "iam", action: "ListUsers" })).toContain("Marker=m-1");
  expect(await call("aws_api", { service: "logs", action: "DescribeLogGroups" })).toContain(
    "nextToken=n-2",
  );
});

test("a key AWS no longer accepts comes back as text for the reader to re-check or re-add", async () => {
  const { call, fake } = setup({ "ec2:DescribeInstances": INSTANCES });
  fake.endpoint.revoke("aws-1");
  const out = await call("aws_api", { service: "ec2", action: "DescribeInstances" });
  expect(out).toContain("Vault → Connections");
  expect(out).toContain("re-check or re-add");
});

test("an AWS error comes back as a sentence with its code", async () => {
  const { call } = setup({
    "ec2:DescribeInstances": xml(
      "<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>not allowed</Message></Error></Errors></Response>",
      403,
    ),
  });
  const out = await call("aws_api", { service: "ec2", action: "DescribeInstances" });
  expect(out).toContain("UnauthorizedOperation: not allowed");
});

test("aws_api_docs answers from the model, and says when the service or action is unknown", async () => {
  const { call, github } = setup({});
  const service = await call("aws_api_docs", { service: "kinesis" });
  expect(service).toContain("protocol json");
  expect(service).toContain("Operations (2): DeleteStream, ListStreams");
  const action = await call("aws_api_docs", { service: "kinesis", action: "DeleteStream" });
  expect(action).toContain("X-Amz-Target Kinesis_20131202.DeleteStream");
  expect(action).toContain("a write: aws_api asks the reader on a confirm card first.");
  expect(action).toContain("Required params: StreamName");
  expect(await call("aws_api_docs", { service: "nosuch" })).toContain("botocore has no");
  expect(await call("aws_api_docs", { service: "kinesis", action: "ListStream" })).toContain(
    "Close ones: ListStreams",
  );
  // The model is read once: one listing, one model.
  expect(github.urls.filter((url) => url.includes("kinesis"))).toHaveLength(2);
});

test("aws_cost reads what was kept and never calls Cost Explorer", async () => {
  const { call, fake } = setup({});
  expect(await call("aws_cost", {})).toContain("has not read this one");
  expect(fake.sent).toHaveLength(0);
});
