/**
 * The AWS keys the reader filed (`api.connections`, provider `aws-keys`):
 * which one a call means, who each one is (STS GetCallerIdentity, kept five
 * minutes), and the one way a request goes out: built by `requestFor`,
 * signed and sent by prifly.
 */

import type { ExtensionConnection, ExtensionConnectionsApi } from "@prifly/extension-api";
import { type AwsRequest, DEFAULT_REGION, errorOf, type Params, type Reply, send } from "./aws";
import { requestFor } from "./model-request";
import { Models } from "./models";
import { tag } from "./xml";

export const PROVIDER = "aws-keys";
export const NO_KEY =
  "No AWS key is filed yet: add one in prifly's Vault → Connections (Add AWS key).";
export const NEEDS_SIGN_IN = "The key needs signing in again.";

const IDENTITY_MS = 5 * 60 * 1000;

/** `alias (1234-5678-9012)`, or just the account id, taken apart. */
export function parseAccount(account: string): { alias: string; accountId: string; name: string } {
  const both = /^(.*?)\s*\((\d{4}-\d{4}-\d{4})\)$/.exec(account.trim());
  if (both !== null)
    return { alias: both[1] ?? "", accountId: both[2] ?? "", name: both[1] || (both[2] ?? "") };
  const id = /^\d{4}-?\d{4}-?\d{4}$/.test(account.trim()) ? account.trim() : "";
  return { alias: "", accountId: id, name: account.trim() };
}

export type Identity = { account: string; arn: string; userId: string; who: string };

type Cached<T> = { at: number; value: T };

export type Resolved =
  | { ok: true; connection: ExtensionConnection }
  | { ok: false; message: string };

export class Accounts {
  private readonly connections: () => ExtensionConnectionsApi | undefined;
  readonly now: () => number;
  readonly models: Models;
  private readonly identities = new Map<string, Cached<Identity | string>>();

  constructor(
    connections: () => ExtensionConnectionsApi | undefined,
    now: () => number = Date.now,
    models: Models = new Models(),
  ) {
    this.connections = connections;
    this.now = now;
    this.models = models;
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

  /** The request for `service` `action`; an `AwsUsageError` saying what cannot be built. */
  prepare(service: string, action: string, params: Params, region: string): Promise<AwsRequest> {
    return requestFor(this.models, service, action, params, region);
  }

  /** Send a prepared request as connection `id`; the host refusing it outright is thrown. */
  async send(id: string, request: AwsRequest): Promise<Reply> {
    const connections = this.connections();
    if (connections === undefined) throw new Error(NO_KEY);
    return send(connections, id, request);
  }

  /** Build and send one request as connection `id`. */
  async call(
    id: string,
    service: string,
    action: string,
    params: Params,
    region: string,
  ): Promise<Reply> {
    return this.send(id, await this.prepare(service, action, params, region));
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
    if (connection.state !== "ok") return NEEDS_SIGN_IN;
    try {
      const reply = await this.call(connection.id, "sts", "GetCallerIdentity", {}, DEFAULT_REGION);
      if (reply.kind === "sign-in") return NEEDS_SIGN_IN;
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
}

/** One sentence from an AWS error body. */
export function failure(text: string): string {
  const { code, message } = errorOf(text);
  return code === ""
    ? "AWS answered with an error."
    : `AWS answered ${code}${message === "" ? "" : `: ${message}`}`;
}
