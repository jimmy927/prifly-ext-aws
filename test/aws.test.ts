import { expect, test } from "bun:test";
import { AwsUsageError, buildRequest, errorOf, flatten, SERVICES } from "../aws";

test("a Query service: form POST with Action and Version, signed for the region and service", () => {
  const request = buildRequest(
    "ec2",
    "DescribeInstances",
    { "InstanceId.1": "i-0abc" },
    "eu-north-1",
  );
  expect(request).toEqual({
    url: "https://ec2.eu-north-1.amazonaws.com/",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: "Action=DescribeInstances&Version=2016-11-15&InstanceId.1=i-0abc",
    region: "eu-north-1",
    service: "ec2",
  });
});

test("CloudWatch is monitoring.<region> signed as monitoring; IAM is global and signed in us-east-1", () => {
  expect(buildRequest("cloudwatch", "DescribeAlarms", {}, "eu-west-1")).toMatchObject({
    url: "https://monitoring.eu-west-1.amazonaws.com/",
    region: "eu-west-1",
    service: "monitoring",
    body: "Action=DescribeAlarms&Version=2010-08-01",
  });
  expect(buildRequest("iam", "ListAccessKeys", {}, "eu-north-1")).toMatchObject({
    url: "https://iam.amazonaws.com/",
    region: "us-east-1",
    service: "iam",
    body: "Action=ListAccessKeys&Version=2010-05-08",
  });
});

test("every Query service has the version the plan names", () => {
  const versions = Object.fromEntries(
    Object.entries(SERVICES).flatMap(([name, def]) =>
      def.protocol === "query" ? [[name, def.version]] : [],
    ),
  );
  expect(versions).toEqual({
    sts: "2011-06-15",
    ec2: "2016-11-15",
    iam: "2010-05-08",
    rds: "2014-10-31",
    elasticloadbalancing: "2015-12-01",
    sns: "2010-03-31",
    cloudformation: "2010-05-15",
    cloudwatch: "2010-08-01",
  });
});

test("a JSON service: JSON body, content type and X-Amz-Target", () => {
  const request = buildRequest("logs", "FilterLogEvents", { logGroupName: "/odi" }, "eu-north-1");
  expect(request).toEqual({
    url: "https://logs.eu-north-1.amazonaws.com/",
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "Logs_20140328.FilterLogEvents",
    },
    body: '{"logGroupName":"/odi"}',
    region: "eu-north-1",
    service: "logs",
  });
  expect(buildRequest("dynamodb", "Scan", {}, "eu-west-1")?.headers).toEqual({
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": "DynamoDB_20120810.Scan",
  });
  expect(buildRequest("ecs", "ListClusters", {}, "eu-west-1")?.headers["x-amz-target"]).toBe(
    "AmazonEC2ContainerServiceV20141113.ListClusters",
  );
});

test("Cost Explorer is ce.us-east-1 signed in us-east-1 whatever the region asked", () => {
  expect(buildRequest("ce", "GetCostAndUsage", {}, "eu-north-1")).toMatchObject({
    url: "https://ce.us-east-1.amazonaws.com/",
    region: "us-east-1",
    service: "ce",
    headers: { "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage" },
  });
});

test("a bad action name is a usage error; a service off the table is left to its model", () => {
  expect(() => buildRequest("ec2", "Describe Instances", {}, "eu-north-1")).toThrow(AwsUsageError);
  expect(buildRequest("kinesis", "ListStreams", {}, "eu-north-1")).toBeNull();
  expect(buildRequest("s3", "ListBuckets", {}, "eu-north-1")).toBeNull();
});

test("lists and objects flatten the way the protocol spells them", () => {
  expect(
    flatten({ InstanceId: ["i-1", "i-2"], Filter: [{ Name: "a", Value: ["x"] }] }, true),
  ).toEqual([
    ["InstanceId.1", "i-1"],
    ["InstanceId.2", "i-2"],
    ["Filter.1.Name", "a"],
    ["Filter.1.Value.1", "x"],
  ]);
  expect(flatten({ AlarmTypes: ["MetricAlarm"], MaxRecords: 5, Skip: null }, false)).toEqual([
    ["AlarmTypes.member.1", "MetricAlarm"],
    ["MaxRecords", "5"],
  ]);
});

test("errorOf reads XML and JSON error bodies", () => {
  expect(errorOf("<E><Code>AccessDenied</Code><Message>nope &amp; no</Message></E>")).toEqual({
    code: "AccessDenied",
    message: "nope & no",
  });
  expect(errorOf('{"__type":"com.amazon#DataUnavailableException","message":"m"}')).toEqual({
    code: "DataUnavailableException",
    message: "m",
  });
  expect(errorOf("plain")).toEqual({ code: "", message: "" });
});
