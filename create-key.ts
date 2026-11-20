/**
 * `aws_create_access_key_to_vault`: a new IAM access key for a user, made
 * only after the reader clicks File it on prifly's vault filing card (the one
 * card), and filed straight into the vault as a kind `other` entry with
 * AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. The secret passes through
 * `produce` into prifly and nowhere else: never an answer, a log or an error.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { type Accounts, failure } from "./accounts";
import { DEFAULT_REGION } from "./aws";
import { NEEDS_UPDATE, type VaultFile, type VaultFileResult } from "./vault-file";
import { tag } from "./xml";

export type CreateKeyDeps = {
  accounts: Accounts;
  /** Undefined on a prifly without "vault-file-values". */
  file: VaultFile | undefined;
  log: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

const VARIABLES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const ENTRY = /^aws-[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_KEYS = 2;
const SIGN_IN =
  "AWS no longer accepts this key (deleted, deactivated or rotated). Do not retry: ask the reader to re-check or re-add it in prifly's Vault → Connections.";

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

/** A key id with all but its last four characters left out. */
export function maskKeyId(id: string): string {
  return `AKIA…${id.slice(-4)}`;
}

/** Each AccessKeyId in an IAM reply. */
function keyIds(xml: string): string[] {
  return [...xml.matchAll(/<AccessKeyId>([^<]+)<\/AccessKeyId>/g)].map((m) => (m[1] ?? "").trim());
}

type Sent = { ok: true; text: string } | { ok: false; message: string };

/** One IAM call; the words of a failure are one sentence, never a raw reply body. */
async function iam(
  deps: CreateKeyDeps,
  id: string,
  action: string,
  params: Record<string, string>,
): Promise<Sent> {
  try {
    const reply = await deps.accounts.call(id, "iam", action, params, DEFAULT_REGION);
    if (reply.kind === "sign-in") return { ok: false, message: SIGN_IN };
    if (reply.status >= 400) return { ok: false, message: failure(reply.text) };
    return { ok: true, text: reply.text };
  } catch (error) {
    // Only request-building and sending errors: they never carry a reply body.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not call AWS: ${message}` };
  }
}

async function deleteKey(
  deps: CreateKeyDeps,
  id: string,
  userName: string,
  keyId: string,
): Promise<boolean> {
  return (await iam(deps, id, "DeleteAccessKey", { UserName: userName, AccessKeyId: keyId })).ok;
}

type Request = { userName: string; vaultEntry: string; why: string };

/** The three required arguments, or the words refusing them. */
function requestOf(args: Record<string, unknown>): Request | string {
  const userName = text(args, "userName");
  const vaultEntry = text(args, "vaultEntry");
  const why = text(args, "why");
  if (userName === "") return "Not done: userName is required (the IAM user the key is for).";
  if (!ENTRY.test(vaultEntry)) {
    return `Not done: vaultEntry "${vaultEntry}" must be a vault name starting with aws- (lowercase letters, digits and dashes), e.g. aws-deploy.`;
  }
  if (why === "" || why.length > 300) {
    return "Not done: why is required, 1 to 300 characters: one line for the reader's card.";
  }
  return { userName, vaultEntry, why };
}

/** IAM's limit of two keys per user, checked with a read (no card); the refusal, or null. */
async function limitRefusal(deps: CreateKeyDeps, id: string, userName: string) {
  const listed = await iam(deps, id, "ListAccessKeys", { UserName: userName });
  if (!listed.ok) return `Not done: ${listed.message}`;
  const existing = keyIds(listed.text);
  if (existing.length < MAX_KEYS) return null;
  const names = existing.map(maskKeyId).join(" and ");
  return `Not done: IAM allows 2 access keys per user and ${userName} already has ${existing.length} (${names}). The reader must delete or deactivate one first.`;
}

async function createKey(deps: CreateKeyDeps, args: Record<string, unknown>): Promise<string> {
  const file = deps.file;
  if (file === undefined) return NEEDS_UPDATE;
  const request = requestOf(args);
  if (typeof request === "string") return request;
  const { userName, vaultEntry, why } = request;
  const picked = deps.accounts.resolve(text(args, "account"));
  if (!picked.ok) return picked.message;
  const id = picked.connection.id;
  const account = picked.connection.account;
  const refusal = await limitRefusal(deps, id, userName);
  if (refusal !== null) return refusal;

  let createdKeyId: string | null = null;
  let deletedInProduce = false;
  const produce = async (): Promise<Record<string, string>> => {
    if (createdKeyId !== null) throw new Error("produce runs once.");
    const made = await iam(deps, id, "CreateAccessKey", { UserName: userName });
    if (!made.ok) throw new Error(made.message);
    const keyId = tag(made.text, "AccessKeyId");
    const secret = tag(made.text, "SecretAccessKey");
    if (keyId !== null && keyId !== "") createdKeyId = keyId;
    if (keyId === null || keyId === "" || secret === null || secret === "") {
      if (createdKeyId !== null)
        deletedInProduce = await deleteKey(deps, id, userName, createdKeyId);
      throw new Error("AWS answered CreateAccessKey without a usable access key.");
    }
    return { AWS_ACCESS_KEY_ID: keyId, AWS_SECRET_ACCESS_KEY: secret };
  };

  let result: VaultFileResult;
  try {
    result = await file(vaultEntry, {
      kind: "other",
      variables: VARIABLES,
      produce,
      creates: `an IAM access key for user ${userName} in account ${account}`,
      why,
    });
  } catch {
    // The error's text is never used: it could carry what produce threw.
    result = { outcome: "failed", message: "", produced: false };
  }
  deps.log("create_key", { outcome: result.outcome, entry: vaultEntry, user: userName, account });
  if (result.outcome === "accepted") return answerOf(result, request, createdKeyId);
  const key = createdKeyId;
  if (key === null) {
    // `result.message` of a failure is never passed on: it could carry what produce threw.
    return result.outcome === "failed"
      ? "Not done: nothing was filed. No key was left behind."
      : answerOf(result, request, null);
  }
  // A key exists although nothing was filed: delete it, whatever the outcome says.
  const deleted = deletedInProduce || (await deleteKey(deps, id, userName, key));
  deps.log("create_key_cleanup", { deleted, entry: vaultEntry, user: userName });
  const lead =
    result.outcome === "failed" && result.produced
      ? "Not done: the vault refused the new key, so nothing was filed."
      : "Not done: nothing was filed.";
  return deleted
    ? `${lead} The key ${maskKeyId(key)} of ${userName} was deleted again.`
    : `${lead} The key ${maskKeyId(key)} of ${userName} could NOT be deleted: the reader must delete it by hand in IAM.`;
}

/** The answer for every outcome but `failed`. */
function answerOf(
  result: Exclude<VaultFileResult, { outcome: "failed" }>,
  request: Request,
  keyId: string | null,
): string {
  switch (result.outcome) {
    case "accepted":
      return `filed as ${request.vaultEntry}, key id ${keyId === null ? "unknown" : maskKeyId(keyId)}, user ${request.userName}`;
    case "declined":
      return "Not done: the reader declined. No key was created.";
    case "timed out":
      return "Not done: the reader did not answer in time. No key was created.";
    case "refused":
      return `Not done: ${result.message} No card was shown and no key was created.`;
  }
}

export function createKeyTool(deps: CreateKeyDeps): ExtensionTool {
  return {
    name: "aws_create_access_key_to_vault",
    description:
      "Gives a command or another service its own IAM access key. Creates a new access key for the IAM user and files it straight into prifly's vault as the kind-other entry vaultEntry (aws-…) with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; the reader confirms ONE card (File it), and only then is the key made. The secret never reaches you: use it afterwards with vault_run and that entry. Answers `filed as <entry>, key id AKIA…xxxx, user <user>`. Refused beforehand when the user already has 2 keys (IAM's limit). Never ask the reader to create keys in the console.",
    inputSchema: {
      type: "object",
      properties: {
        userName: { type: "string", description: "The IAM user the key is for." },
        vaultEntry: {
          type: "string",
          description:
            "The vault entry to file it as: aws- then lowercase letters, digits, dashes.",
        },
        account: {
          type: "string",
          description: "A connection id, account id or alias; left out, the only or first key.",
        },
        why: { type: "string", description: "One line for the card (1 to 300 characters)." },
      },
      required: ["userName", "vaultEntry", "why"],
      additionalProperties: false,
    },
    call: (args) => createKey(deps, args),
  };
}
