import { expect, test } from "bun:test";
import { Accounts } from "../accounts";
import { createKeyTool } from "../create-key";
import { Models } from "../models";
import type { VaultFile, VaultFileRequest, VaultFileResult } from "../vault-file";
import { type Canned, fakeAws, xml, xmlError } from "./fake-aws";
import { fakeGithub } from "./fake-models";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzSECRETzz9";
const KEY_ID = "AKIAIOSFODNN7EXAMPLEABCD";

const CREATED = xml(
  `<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><UserName>u</UserName><AccessKeyId>${KEY_ID}</AccessKeyId><Status>Active</Status><SecretAccessKey>${SECRET}</SecretAccessKey></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`,
);
const NO_KEYS = xml(
  "<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata/></ListAccessKeysResult></ListAccessKeysResponse>",
);
const member = (id: string) =>
  `<member><UserName>u</UserName><AccessKeyId>${id}</AccessKeyId></member>`;
const TWO_KEYS = xml(
  `<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata>${member("AKIAOLDONE000000AAAA")}${member("AKIAOLDTWO000000BBBB")}</AccessKeyMetadata></ListAccessKeysResult></ListAccessKeysResponse>`,
);
const DELETED = xml("<DeleteAccessKeyResponse/>");

const GOOD: Record<string, Canned> = {
  "iam:ListAccessKeys": NO_KEYS,
  "iam:CreateAccessKey": CREATED,
  "iam:DeleteAccessKey": DELETED,
};

type Filing = (name: string, request: VaultFileRequest) => Promise<VaultFileResult>;

function setup(table: Record<string, Canned>, filing: Filing | null) {
  const fake = fakeAws(table);
  const accounts = new Accounts(
    () => fake.connections,
    () => Date.parse("2026-10-11T12:00:00Z"),
    new Models(fakeGithub().fetch),
  );
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const filed: { name: string; request: VaultFileRequest }[] = [];
  const file: VaultFile | undefined =
    filing === null
      ? undefined
      : (name, request) => {
          filed.push({ name, request });
          return filing(name, request);
        };
  const tool = createKeyTool({
    accounts,
    file,
    log: (event, fields) => void logs.push({ event, fields }),
  });
  const call = (args: Record<string, unknown>) =>
    tool.call(
      { userName: "u", vaultEntry: "aws-x", why: "for the deploy script", ...args },
      {
        session: "4e1c90ab-1111",
        pick: async () => null,
        signal: new AbortController().signal,
        scratchpad: "/tmp",
      },
    );
  const actions = () => fake.sent.map((each) => new URLSearchParams(each.body).get("Action"));
  return { fake, logs, filed, call, actions, tool };
}

/** The host clicking File it: runs produce, then accepts. */
const accepting: Filing = async (_name, request) => {
  await request.produce();
  return { outcome: "accepted", level: 1 };
};

/** Nothing the tool answered or logged may hold the secret. */
function expectNoSecret(answers: string[], logs: { fields: Record<string, unknown> }[]) {
  for (const answer of answers) expect(answer).not.toContain(SECRET);
  expect(JSON.stringify(logs)).not.toContain(SECRET);
}

test("happy path: files the key and answers only the last four of its id", async () => {
  const { call, logs, filed, actions } = setup(GOOD, async (_n, request) => {
    const values = await request.produce();
    expect(values).toEqual({ AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET });
    return { outcome: "accepted", level: 1 };
  });
  const answer = await call({ userName: "u", vaultEntry: "aws-x" });
  expect(answer).toBe("filed as aws-x, key id AKIA…ABCD, user u");
  expectNoSecret([answer], logs);
  expect(filed).toHaveLength(1);
  expect(filed[0]?.name).toBe("aws-x");
  expect(filed[0]?.request).toMatchObject({
    kind: "other",
    variables: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    creates: "an IAM access key for user u in account example-prod (1234-5678-9012)",
    why: "for the deploy script",
  });
  expect(actions()).toEqual(["ListAccessKeys", "CreateAccessKey"]);
});

test("a failed filing after the key exists deletes it and says so", async () => {
  const { call, logs, fake, actions } = setup(GOOD, async (_n, request) => {
    await request.produce();
    return { outcome: "failed", message: `refused ${SECRET}`, produced: true };
  });
  const answer = await call({});
  expect(actions()).toEqual(["ListAccessKeys", "CreateAccessKey", "DeleteAccessKey"]);
  const deletion = new URLSearchParams(fake.sent[2]?.body);
  expect(deletion.get("AccessKeyId")).toBe(KEY_ID);
  expect(deletion.get("UserName")).toBe("u");
  expect(answer).toContain("was deleted again");
  expect(answer).toContain("AKIA…ABCD");
  expect(answer).not.toContain(KEY_ID);
  expectNoSecret([answer], logs);
});

test("when the delete fails too, the answer names the key (last four) for deleting by hand", async () => {
  const { call, logs } = setup(
    { ...GOOD, "iam:DeleteAccessKey": xmlError("AccessDenied", "no", 403) },
    async (_n, request) => {
      await request.produce();
      return { outcome: "failed", message: SECRET, produced: true };
    },
  );
  const answer = await call({});
  expect(answer).toContain("could NOT be deleted");
  expect(answer).toContain("AKIA…ABCD");
  expect(answer).not.toContain(KEY_ID);
  expectNoSecret([answer], logs);
});

test("a produce error holding the secret does not leak", async () => {
  const { call, logs } = setup(
    {
      ...GOOD,
      "iam:CreateAccessKey": xml(
        `<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><SecretAccessKey>${SECRET}</SecretAccessKey></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`,
      ),
    },
    async (_n, request) => {
      try {
        await request.produce();
        return { outcome: "accepted", level: 1 };
      } catch (error) {
        // A host may well pass the thrown text on; the tool must not repeat it.
        return {
          outcome: "failed",
          message: `${error instanceof Error ? error.message : ""} ${SECRET}`,
          produced: false,
        };
      }
    },
  );
  const answer = await call({});
  expect(answer).toStartWith("Not done");
  expectNoSecret([answer], logs);
});

test("produce throws only text without secret or raw reply", async () => {
  const { filed, call } = setup(
    { ...GOOD, "iam:CreateAccessKey": xml(`<broken>${SECRET}</broken>`) },
    async () => ({ outcome: "declined" }),
  );
  await call({});
  const produce = filed[0]?.request.produce;
  expect(produce).toBeDefined();
  const error = await (produce as () => Promise<unknown>)().catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(SECRET);
});

test("a key made but unusable (no secret in the reply) is deleted before the throw", async () => {
  const { filed, call, actions } = setup(
    {
      ...GOOD,
      "iam:CreateAccessKey": xml(
        `<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><AccessKeyId>${KEY_ID}</AccessKeyId></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`,
      ),
    },
    async (_n, request) => {
      try {
        await request.produce();
      } catch {
        return { outcome: "failed", message: "x", produced: false };
      }
      return { outcome: "accepted", level: 1 };
    },
  );
  const answer = await call({});
  expect(filed).toHaveLength(1);
  expect(actions()).toEqual(["ListAccessKeys", "CreateAccessKey", "DeleteAccessKey"]);
  expect(answer).toContain("was deleted again");
});

test("two keys already: refused, nothing created, file never called", async () => {
  const { call, filed, actions } = setup({ ...GOOD, "iam:ListAccessKeys": TWO_KEYS }, accepting);
  const answer = await call({});
  expect(answer).toContain("2 access keys");
  expect(answer).toContain("AKIA…AAAA");
  expect(answer).toContain("AKIA…BBBB");
  expect(answer).not.toContain("AKIAOLDONE");
  expect(filed).toHaveLength(0);
  expect(actions()).toEqual(["ListAccessKeys"]);
});

test("NoSuchEntity on the listing is one sentence and nothing is created", async () => {
  const { call, filed, actions } = setup(
    { ...GOOD, "iam:ListAccessKeys": xmlError("NoSuchEntity", "user u not found", 404) },
    accepting,
  );
  const answer = await call({});
  expect(answer).toContain("NoSuchEntity");
  expect(filed).toHaveLength(0);
  expect(actions()).toEqual(["ListAccessKeys"]);
});

test("without the vault-file-values feature: update prifly, no AWS call", async () => {
  const { call, actions, fake } = setup(GOOD, null);
  const answer = await call({});
  expect(answer).toContain("update prifly");
  expect(fake.sent).toHaveLength(0);
  expect(actions()).toEqual([]);
});

test("bad arguments are refused before any call", async () => {
  const { call, fake, filed } = setup(GOOD, accepting);
  expect(await call({ vaultEntry: "prod-key" })).toContain("aws-");
  expect(await call({ vaultEntry: "aws-Upper" })).toContain("aws-");
  expect(await call({ vaultEntry: "aws-" })).toContain("aws-");
  expect(await call({ userName: "" })).toContain("userName");
  expect(await call({ why: "" })).toContain("why");
  expect(await call({ why: "x".repeat(301) })).toContain("why");
  expect(await call({ account: "nope" })).toContain("No AWS key matches");
  expect(fake.sent).toHaveLength(0);
  expect(filed).toHaveLength(0);
});

test("declined, timed out and refused: no CreateAccessKey is sent", async () => {
  const outcomes: VaultFileResult[] = [
    { outcome: "declined" },
    { outcome: "timed out" },
    { outcome: "refused", message: "That name is another kind." },
  ];
  for (const outcome of outcomes) {
    const { call, actions } = setup(GOOD, async () => outcome);
    const answer = await call({});
    expect(answer).toStartWith("Not done");
    expect(answer.toLowerCase()).toContain("no key was created");
    expect(actions()).toEqual(["ListAccessKeys"]);
  }
  const refused = setup(GOOD, async () => ({ outcome: "refused", message: "Name not allowed." }));
  expect(await refused.call({})).toContain("Name not allowed.");
});

test("failed with produced false and no key made leaves nothing behind", async () => {
  const { call, actions } = setup(GOOD, async () => ({
    outcome: "failed",
    message: "boom",
    produced: false,
  }));
  expect(await call({})).toContain("No key was left behind");
  expect(actions()).toEqual(["ListAccessKeys"]);
});

test("a scan over every scenario: no answer and no log field holds the secret", async () => {
  const scenarios: Filing[] = [
    accepting,
    async (_n, r) => {
      await r.produce();
      return { outcome: "failed", message: SECRET, produced: true };
    },
    async (_n, r) => {
      await r.produce();
      return { outcome: "failed", message: SECRET, produced: false };
    },
    async () => ({ outcome: "refused", message: "no" }),
    async () => ({ outcome: "declined" }),
  ];
  const answers: string[] = [];
  const allLogs: { fields: Record<string, unknown> }[] = [];
  for (const scenario of scenarios) {
    const { call, logs } = setup(GOOD, scenario);
    answers.push(await call({}));
    allLogs.push(...logs);
  }
  expect(allLogs.length).toBeGreaterThan(0);
  expectNoSecret(answers, allLogs);
  for (const answer of answers) expect(answer).not.toContain(KEY_ID);
});
