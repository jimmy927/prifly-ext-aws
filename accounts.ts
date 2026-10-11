/**
 * The AWS keys the reader filed (`api.connections`, provider `aws-keys`):
 * which one a call means, who each one is (STS GetCallerIdentity) and how old
 * its access key is (IAM). Identities are kept five minutes, key ages an hour.
 */

import type { ExtensionConnection, ExtensionConnectionsApi } from "@prifly/extension-api";
import { buildRequest, DEFAULT_REGION, errorOf, type Params, type Reply, send } from "./aws";
import { inner, members, tag } from "./xml";

export const PROVIDER = "aws-keys";
export const NO_KEY =
  "No AWS key is filed yet: add one in prifly's Vault → Connections (Add AWS key), or from the AWS panel.";

const IDENTITY_MS = 5 * 60 * 1000;
const KEY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const ROTATE_AFTER_DAYS = 90;

/** `alias (1234-5678-9012)`, or just the account id, taken apart. */
export function parseAccount(account: string): { alias: string; accountId: string; name: string } {
  const both = /^(.*?)\s*\((\d{4}-\d{4}-\d{4})\)$/.exec(account.trim());
  if (both !== null)
    return { alias: both[1] ?? "", accountId: both[2] ?? "", name: both[1] || (both[2] ?? "") };
  const id = /^\d{4}-?\d{4}-?\d{4}$/.test(account.trim()) ? account.trim() : "";
  return { alias: "", accountId: id, name: account.trim() };
}

export type Identity = { account: string; arn: string; userId: string; who: string };

/** The access key in use, as far as IAM lets the key's own user see. */
export type KeyInfo =
  | {
      known: true;
      /** `AKIA…7QX2` */
      masked: string;
      ageDays: number;
      rotate: boolean;
      /** ISO time or null when never used. */
      lastUsed: string | null;
    }
  | { known: false; reason: string };

type Cached<T> = { at: number; value: T };

export type Resolved =
  | { ok: true; connection: ExtensionConnection }
  | { ok: false; message: string };

export class Accounts {
  private readonly connections: () => ExtensionConnectionsApi | undefined;
  readonly now: () => number;
  private readonly identities = new Map<string, Cached<Identity | string>>();
  private readonly keys = new Map<string, Cached<KeyInfo>>();

  constructor(
    connections: () => ExtensionConnectionsApi | undefined,
    now: () => number = Date.now,
  ) {
    this.connections = connections;
    this.now = now;
  }

  list(): ExtensionConnection[] {
    return this.connections()?.list(PROVIDER) ?? [];
  }

  /** The connection a call means: by id, account id (dashes or not), alias; the first when none is named. */
  resolve(ref: string | undefined): Resolved {
    const all = this.list();
    if (all.length === 0) return { ok: false, message: NO_KEY };
    const wanted = (ref ?? "").trim().toLowerCase();
    if (wanted === "") return { ok: true, connection: all[0] as ExtensionConnection };
    const digits = wanted.replace(/-/g, "");
    const found = all.find((each) => {
      const parsed = parseAccount(each.account);
      return (
        each.id.toLowerCase() === wanted ||
        each.account.toLowerCase() === wanted ||
        parsed.alias.toLowerCase() === wanted ||
        (parsed.accountId !== "" && parsed.accountId.replace(/-/g, "") === digits)
      );
    });
    if (found !== undefined) return { ok: true, connection: found };
    const known = all.map((each) => `${each.id} (${each.account})`).join(", ");
    return { ok: false, message: `No AWS key matches "${ref}". The filed ones: ${known}.` };
  }

  /** Send one request as connection `id`; the host refusing it outright is thrown. */
  async call(
    id: string,
    service: string,
    action: string,
    params: Params,
    region: string,
  ): Promise<Reply> {
    const connections = this.connections();
    if (connections === undefined) throw new Error(NO_KEY);
    return send(connections, id, buildRequest(service, action, params, region));
  }

  /** Who the key is, kept five minutes; a sentence instead when it cannot say. */
  async identity(connection: ExtensionConnection): Promise<Identity | string> {
    const held = this.identities.get(connection.id);
    if (held !== undefined && this.now() - held.at < IDENTITY_MS) return held.value;
    const value = await this.readIdentity(connection);
    this.identities.set(connection.id, { at: this.now(), value });
    return value;
  }

  private async readIdentity(connection: ExtensionConnection): Promise<Identity | string> {
    if (connection.state !== "ok") return "The key needs signing in again.";
    try {
      const reply = await this.call(connection.id, "sts", "GetCallerIdentity", {}, DEFAULT_REGION);
      if (reply.kind === "sign-in") return "The key needs signing in again.";
      if (reply.status >= 400) return failure(reply.text);
      const arn = tag(reply.text, "Arn") ?? "";
      return {
        account: tag(reply.text, "Account") ?? "",
        arn,
        userId: tag(reply.text, "UserId") ?? "",
        who: arn.replace(/^arn:[^:]*:(iam|sts)::\d+:/, ""),
      };
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The age of the key in use, kept an hour; "unknown" and why when IAM will not say. */
  async keyInfo(connection: ExtensionConnection): Promise<KeyInfo> {
    const held = this.keys.get(connection.id);
    if (held !== undefined && this.now() - held.at < KEY_MS) return held.value;
    const value = await this.readKey(connection);
    this.keys.set(connection.id, { at: this.now(), value });
    return value;
  }

  private async readKey(connection: ExtensionConnection): Promise<KeyInfo> {
    if (connection.state !== "ok")
      return { known: false, reason: "The key needs signing in again." };
    try {
      const listed = await this.call(connection.id, "iam", "ListAccessKeys", {}, "us-east-1");
      if (listed.kind === "sign-in")
        return { known: false, reason: "The key needs signing in again." };
      if (listed.status >= 400) return { known: false, reason: failure(listed.text) };
      return await this.newestUsed(connection.id, listed.text);
    } catch (error) {
      return { known: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * prifly does not say which access key a connection holds, so it is the
   * active one IAM saw used last (every read this extension makes uses it).
   */
  private async newestUsed(id: string, listXml: string): Promise<KeyInfo> {
    const keys = members(inner(listXml, "AccessKeyMetadata") ?? "").flatMap((each) => {
      const keyId = tag(each, "AccessKeyId");
      const created = Date.parse(tag(each, "CreateDate") ?? "");
      return keyId === null || tag(each, "Status") !== "Active" || Number.isNaN(created)
        ? []
        : [{ keyId, created }];
    });
    if (keys.length === 0)
      return { known: false, reason: "IAM lists no active access key for this user." };
    let best: { keyId: string; created: number; used: number | null } | null = null;
    for (const key of keys) {
      const used = await this.lastUsed(id, key.keyId);
      if (best === null || (used ?? -1) > (best.used ?? -1)) best = { ...key, used };
    }
    if (best === null)
      return { known: false, reason: "IAM lists no active access key for this user." };
    const ageDays = Math.max(0, Math.floor((this.now() - best.created) / DAY_MS));
    return {
      known: true,
      masked: `${best.keyId.slice(0, 4)}…${best.keyId.slice(-4)}`,
      ageDays,
      rotate: ageDays > ROTATE_AFTER_DAYS,
      lastUsed: best.used === null ? null : new Date(best.used).toISOString(),
    };
  }

  private async lastUsed(id: string, keyId: string): Promise<number | null> {
    const reply = await this.call(
      id,
      "iam",
      "GetAccessKeyLastUsed",
      { AccessKeyId: keyId },
      "us-east-1",
    );
    if (reply.kind !== "reply" || reply.status >= 400) return null;
    const used = Date.parse(tag(reply.text, "LastUsedDate") ?? "");
    return Number.isNaN(used) ? null : used;
  }
}

/** One sentence from an AWS error body. */
export function failure(text: string): string {
  const { code, message } = errorOf(text);
  return code === ""
    ? "AWS answered with an error."
    : `AWS answered ${code}${message === "" ? "" : `: ${message}`}`;
}
