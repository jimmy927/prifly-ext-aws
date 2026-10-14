import { expect, test } from "bun:test";
import { judge, REDACTED, redact } from "../allowlist";

type Row = [string, string, Record<string, unknown>, "read" | "secret" | "cost" | "write"];

const TABLE: Row[] = [
  // Reads by prefix.
  ["ec2", "DescribeInstances", {}, "read"],
  ["iam", "ListAccessKeys", {}, "read"],
  ["iam", "GetAccessKeyLastUsed", { AccessKeyId: "AKIAEXAMPLE" }, "read"],
  ["cloudwatch", "GetMetricData", {}, "read"],
  ["resource-explorer-2", "Search", {}, "read"],
  ["cloudtrail", "LookupEvents", {}, "read"],
  ["lambda", "BatchGetFunction", {}, "read"],
  ["dynamodb", "Query", {}, "read"],
  ["dynamodb", "Scan", {}, "read"],
  ["logs", "FilterLogEvents", {}, "read"],
  ["sts", "GetCallerIdentity", {}, "read"],
  ["ec2", "DescribeKeyPairs", {}, "read"],
  ["ssm", "GetParameter", { Name: "/a/b" }, "read"],
  ["ssm", "GetParameter", { Name: "/a/b", WithDecryption: false }, "read"],
  ["ec2", "DescribeInstanceAttribute", { Attribute: "instanceType" }, "read"],
  // Writes that answer with a new secret, and BatchGet* of secrets.
  ["iam", "CreateAccessKey", { UserName: "x" }, "secret"],
  ["iam", "CreateServiceSpecificCredential", {}, "secret"],
  ["ec2", "CreateKeyPair", { KeyName: "k" }, "secret"],
  ["secretsmanager", "BatchGetSecretValue", {}, "secret"],
  ["ssm", "GetParameterHistory", { Name: "x", WithDecryption: true }, "secret"],
  // Plaintext key material, decrypted values and auth tokens.
  ["kms", "Decrypt", { CiphertextBlob: "x" }, "secret"],
  ["kms", "GenerateDataKey", { KeyId: "k" }, "secret"],
  ["kms", "GenerateDataKeyPair", { KeyId: "k" }, "secret"],
  ["sso-oidc", "CreateToken", {}, "secret"],
  ["cognito-idp", "InitiateAuth", {}, "secret"],
  ["cognito-idp", "AdminInitiateAuth", {}, "secret"],
  ["cognito-idp", "RespondToAuthChallenge", {}, "secret"],
  ["kms", "Encrypt", { KeyId: "k", Plaintext: "x" }, "write"],
  // Whatever the case of the action.
  ["ec2", "getPasswordData", {}, "secret"],
  ["kms", "decrypt", {}, "secret"],
  ["ssm", "getParameter", { Name: "x", WithDecryption: true }, "secret"],
  ["ec2", "describeInstanceAttribute", { Attribute: "userData" }, "secret"],
  // Get* that reveal a secret.
  ["secretsmanager", "GetSecretValue", {}, "secret"],
  ["ec2", "GetPasswordData", {}, "secret"],
  ["ecr", "GetAuthorizationToken", {}, "secret"],
  ["sts", "GetSessionToken", {}, "secret"],
  ["sts", "GetFederationToken", {}, "secret"],
  ["ssm", "GetInstanceAccessDetails", {}, "secret"],
  ["ec2", "GetInstanceAccessDetails", {}, "secret"],
  ["iam", "GetCredentialReport", {}, "secret"],
  ["lightsail", "GetKeyPair", {}, "secret"],
  ["kms", "GetPrivateKey", {}, "secret"],
  // sts: all but GetCallerIdentity.
  ["sts", "AssumeRole", {}, "secret"],
  ["sts", "DecodeAuthorizationMessage", {}, "secret"],
  // ssm decryption, in either spelling of true.
  ["ssm", "GetParameter", { Name: "x", WithDecryption: true }, "secret"],
  ["ssm", "GetParameters", { "Names.1": "x", WithDecryption: "true" }, "secret"],
  ["ssm", "GetParametersByPath", { Path: "/", WithDecryption: "True" }, "secret"],
  // ec2 userData.
  ["ec2", "DescribeInstanceAttribute", { Attribute: "userData", InstanceId: "i-1" }, "secret"],
  ["ec2", "DescribeInstanceAttribute", { Attribute: "USERDATA", InstanceId: "i-1" }, "secret"],
  // Cost Explorer costs money, whatever the action.
  ["ce", "GetCostAndUsage", {}, "cost"],
  ["ce", "GetCostForecast", {}, "cost"],
  ["CE", "DescribeCostCategoryDefinition", {}, "cost"],
  // Everything else is a write.
  ["ec2", "TerminateInstances", {}, "write"],
  ["ec2", "RunInstances", {}, "write"],
  ["s3", "PutObject", {}, "write"],
  ["lambda", "Invoke", {}, "write"],
  ["iam", "CreateUser", {}, "write"],
  ["logs", "StartQuery", {}, "write"],
  ["sns", "Publish", {}, "write"],
  ["rds", "DeleteDBInstance", {}, "write"],
  ["ec2", "Getaway", {}, "write"],
  ["ec2", "Describe Instances", {}, "write"],
  ["dynamodb", "PutItem", {}, "write"],
];

for (const [service, action, params, want] of TABLE) {
  test(`${service} ${action} ${JSON.stringify(params)} is ${want}`, () => {
    const verdict = judge(service, action, params);
    if (want === "read" || want === "write") {
      expect(verdict).toEqual({ kind: want });
    } else {
      expect(verdict).toMatchObject({ kind: "refused", rule: want });
    }
  });
}

test("every refusal names its rule; a secret one says no confirm lifts it", () => {
  const secret = judge("secretsmanager", "GetSecretValue");
  const cost = judge("ce", "GetCostAndUsage");
  if (secret.kind !== "refused" || cost.kind !== "refused") throw new Error("not refused");
  expect(secret.message).toStartWith("Refused: would reveal a secret.");
  expect(secret.message).toContain("whoever confirms it");
  expect(cost.message).toStartWith("Refused: costs money.");
  expect(cost.message).toContain("aws_cost");
});

test("lambda Environment values are redacted, names kept", () => {
  const reply = JSON.stringify({
    Functions: [
      { FunctionName: "api", Environment: { Variables: { DB_PASSWORD: "hunter2", MODE: "prod" } } },
    ],
  });
  const out = redact(reply);
  expect(out).not.toContain("hunter2");
  expect(JSON.parse(out)).toEqual({
    Functions: [
      {
        FunctionName: "api",
        Environment: { Variables: { DB_PASSWORD: REDACTED, MODE: REDACTED } },
      },
    ],
  });
});

test("ECS environment and secrets values are redacted, names kept", () => {
  const reply = JSON.stringify({
    taskDefinition: {
      containerDefinitions: [
        {
          name: "web",
          image: "x",
          environment: [{ name: "TOKEN", value: "s3cr3t" }],
          secrets: [{ name: "DB", valueFrom: "arn:aws:secretsmanager:eu-north-1:1:secret:db" }],
        },
      ],
    },
  });
  const out = redact(reply);
  expect(out).not.toContain("s3cr3t");
  expect(out).not.toContain("secretsmanager");
  expect(JSON.parse(out).taskDefinition.containerDefinitions[0]).toEqual({
    name: "web",
    image: "x",
    environment: [{ name: "TOKEN", value: REDACTED }],
    secrets: [{ name: "DB", valueFrom: REDACTED }],
  });
});

test("a Lambda's signed code link and an EC2 launch template's userData are redacted", () => {
  expect(
    redact(JSON.stringify({ Code: { Location: "https://s3/x?sig=1", RepositoryType: "S3" } })),
  ).not.toContain("sig=1");
  const xml = "<r><userData>IyEvYmluL3NoCnNlY3JldA==</userData><b>1</b></r>";
  expect(redact(xml)).toBe(`<r><userData>${REDACTED}</userData><b>1</b></r>`);
});

test("a reply that is neither is returned as it is", () => {
  expect(redact("<a>1</a>")).toBe("<a>1</a>");
  expect(redact("{not json")).toBe("{not json");
});
