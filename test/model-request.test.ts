import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AwsUsageError } from "../aws";
import { modelRequest, requestFor } from "../model-request";
import { Models, protocolOf, type ServiceModel } from "../models";
import { fakeGithub, MODELS } from "./fake-models";

function model(name: string): ServiceModel {
  const found = MODELS[name];
  if (found === undefined) throw new Error(name);
  return {
    ...(found.model as Omit<ServiceModel, "service" | "version">),
    service: name,
    version: found.version,
  };
}

test("the newest version folder is read, once, and kept", async () => {
  const github = fakeGithub();
  const models = new Models(github.fetch);
  const s3 = await models.load("s3");
  await models.load("s3");
  expect(s3.version).toBe("2006-03-01");
  expect(github.urls).toEqual([
    "https://api.github.com/repos/boto/botocore/contents/botocore/data/s3",
    "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/s3/2006-03-01/service-2.json",
  ]);
});

test("elasticloadbalancing is botocore's elbv2; a name with odd characters is refused unsent", async () => {
  const github = fakeGithub();
  const models = new Models(github.fetch);
  await expect(models.load("elasticloadbalancing")).rejects.toThrow('no AWS service "elbv2"');
  await expect(models.load("../etc")).rejects.toThrow(AwsUsageError);
  expect(github.urls).toHaveLength(1);
});

test("a table service needs no model; any other is built from it", async () => {
  const github = fakeGithub();
  const models = new Models(github.fetch);
  const ec2 = await requestFor(models, "ec2", "RunInstances", { ImageId: "ami-1" }, "eu-north-1");
  expect(ec2.body).toBe("Action=RunInstances&Version=2016-11-15&ImageId=ami-1");
  expect(github.urls).toHaveLength(0);
  const kinesis = await requestFor(
    models,
    "kinesis",
    "DeleteStream",
    { StreamName: "s" },
    "eu-west-1",
  );
  expect(kinesis).toEqual({
    url: "https://kinesis.eu-west-1.amazonaws.com/",
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "Kinesis_20131202.DeleteStream",
    },
    body: '{"StreamName":"s"}',
    region: "eu-west-1",
    service: "kinesis",
  });
});

test("rest-xml: uri, greedy key, header, query, and a dotted bucket stays in the path", () => {
  const s3 = model("s3");
  expect(protocolOf(s3)).toBe("rest-xml");
  expect(
    modelRequest(
      s3,
      "GetObject",
      { Bucket: "logs", Key: "a b/c.txt", Range: "bytes=0-9" },
      "eu-north-1",
    ),
  ).toEqual({
    url: "https://logs.s3.eu-north-1.amazonaws.com/a%20b/c.txt",
    method: "GET",
    headers: { range: "bytes=0-9" },
    region: "eu-north-1",
    service: "s3",
  });
  expect(
    modelRequest(s3, "ListObjectsV2", { Bucket: "my.dotted", MaxKeys: 5 }, "eu-north-1").url,
  ).toBe("https://s3.eu-north-1.amazonaws.com/my.dotted?list-type=2&max-keys=5");
});

test("rest-xml: a structure payload is the XML body, namespaced, with Content-MD5 when the model asks", () => {
  const request = modelRequest(
    model("s3"),
    "PutBucketTagging",
    { Bucket: "b1", Tagging: { TagSet: [{ Key: "a&b", Value: "<x>" }] } },
    "eu-north-1",
  );
  const body =
    '<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>a&amp;b</Key><Value>&lt;x&gt;</Value></Tag></TagSet></Tagging>';
  expect(request).toEqual({
    url: "https://b1.s3.eu-north-1.amazonaws.com/?tagging",
    method: "PUT",
    headers: {
      "content-type": "application/xml",
      "content-md5": createHash("md5").update(body).digest("base64"),
    },
    body,
    region: "eu-north-1",
    service: "s3",
  });
});

test("rest-json: the members left over are the JSON body; a blob payload goes as it is", () => {
  const lambda = model("lambda");
  expect(
    modelRequest(
      lambda,
      "UpdateFunctionConfiguration",
      { FunctionName: "api", Timeout: 30 },
      "eu-north-1",
    ),
  ).toEqual({
    url: "https://lambda.eu-north-1.amazonaws.com/2015-03-31/functions/api/configuration",
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: '{"Timeout":30}',
    region: "eu-north-1",
    service: "lambda",
  });
  const invoke = modelRequest(
    lambda,
    "Invoke",
    { FunctionName: "api", InvocationType: "DryRun", Payload: { ping: 1 } },
    "eu-north-1",
  );
  expect(invoke).toMatchObject({
    url: "https://lambda.eu-north-1.amazonaws.com/2015-03-31/functions/api/invocations",
    method: "POST",
    headers: { "x-amz-invocation-type": "DryRun" },
    body: '{"ping":1}',
  });
  expect(modelRequest(lambda, "ListFunctions", { MaxItems: 2 }, "eu-north-1").url).toBe(
    "https://lambda.eu-north-1.amazonaws.com/2015-03-31/functions/?MaxItems=2",
  );
});

test("a global service goes to its global endpoint, signed in us-east-1", () => {
  expect(modelRequest(model("route53"), "ListHostedZones", {}, "eu-north-1")).toMatchObject({
    url: "https://route53.amazonaws.com/2013-04-01/hostedzone",
    region: "us-east-1",
    service: "route53",
  });
});

test("a missing required param or an unknown action is a usage error", () => {
  expect(() => modelRequest(model("s3"), "GetObject", { Bucket: "b" }, "eu-north-1")).toThrow(
    'GetObject needs "Key" in params.',
  );
  expect(() => modelRequest(model("s3"), "PutBucketPolicy", {}, "eu-north-1")).toThrow(
    AwsUsageError,
  );
});
