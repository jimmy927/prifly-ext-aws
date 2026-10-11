/**
 * What the panel's page asks for at `api/<path>`, answered as JSON:
 *
 *  - `accounts`: each filed key, who it is, its access key's age;
 *  - `cost`: the kept Cost Explorer reading per account (never a live call);
 *  - `alarms`: the alarms in ALARM (`?refresh=1` polls first);
 *  - `calls`: what sessions' `aws_call`s did today;
 *  - `sign-in`: opens prifly's "Add AWS key" form.
 */

import type { ExtensionConnectionsApi, PanelRequest } from "@prifly/extension-api";
import { type Accounts, PROVIDER, parseAccount } from "./accounts";
import type { AlarmWatch } from "./alarms";
import type { CallLog } from "./calls";
import type { CostStore } from "./cost";

export type PanelDeps = {
  accounts: Accounts;
  alarms: AlarmWatch;
  cost: CostStore;
  calls: CallLog;
  connections: () => ExtensionConnectionsApi | undefined;
  /** A session's title, when prifly still knows it. */
  titleOf: (session: string) => string | null;
  /** Read again after a key was added. */
  afterSignIn: () => void;
};

async function accountsRoute(deps: PanelDeps): Promise<unknown> {
  const rows = await Promise.all(
    deps.accounts.list().map(async (each) => {
      const parsed = parseAccount(each.account);
      const identity = await deps.accounts.identity(each);
      return {
        id: each.id,
        name: parsed.name,
        alias: parsed.alias,
        accountId: parsed.accountId,
        state: each.state,
        identity: typeof identity === "string" ? null : identity.who,
        problem: typeof identity === "string" ? identity : null,
        key: await deps.accounts.keyInfo(each),
        alarmRegions: deps.alarms.regionsOf(each.id),
      };
    }),
  );
  return { accounts: rows };
}

function costRoute(deps: PanelDeps, request: PanelRequest): unknown {
  const wanted = request.query["account"] ?? "";
  const picked = deps.accounts.resolve(wanted);
  if (!picked.ok) return { account: null, status: "no-key", message: picked.message };
  const { connection } = picked;
  const name = parseAccount(connection.account).name;
  if (connection.state !== "ok") {
    return {
      account: connection.id,
      name,
      status: "sign-in",
      message: "The key needs signing in again.",
    };
  }
  const entry = deps.cost.get(connection.id);
  if (entry === null) return { account: connection.id, name, status: "pending" };
  if (entry.note !== null) {
    return {
      account: connection.id,
      name,
      status: "note",
      note: entry.note,
      readAt: entry.readAt,
      reads: entry.reads,
    };
  }
  return { account: connection.id, name, status: "ready", entry };
}

async function alarmsRoute(deps: PanelDeps, request: PanelRequest): Promise<unknown> {
  if (request.query["refresh"] === "1") await deps.alarms.poll();
  const readAt = deps.alarms.lastRead();
  return {
    readAt: readAt === null ? null : new Date(readAt).toISOString(),
    alarms: deps.alarms.alarms(),
    problems: deps.accounts.list().flatMap((each) => {
      const problem = deps.alarms.problemOf(each.id);
      return problem === null
        ? []
        : [{ account: each.id, name: parseAccount(each.account).name, problem }];
    }),
  };
}

function callsRoute(deps: PanelDeps): unknown {
  return {
    calls: deps.calls.today().map((entry) => {
      const title = deps.titleOf(entry.session);
      return { ...entry, sessionTitle: title, sessionShort: entry.session.slice(0, 8) };
    }),
  };
}

async function signInRoute(deps: PanelDeps): Promise<unknown> {
  const connections = deps.connections();
  if (connections === undefined) return { ok: false, message: "This prifly has no connections." };
  const result = await connections.signIn(PROVIDER, []);
  if (result.ok) deps.afterSignIn();
  return result;
}

/** The panel's one entry: `index.ts` hands each request here. */
export function answer(deps: PanelDeps, request: PanelRequest): unknown {
  switch (request.path) {
    case "accounts":
      return accountsRoute(deps);
    case "cost":
      return costRoute(deps, request);
    case "alarms":
      return alarmsRoute(deps, request);
    case "calls":
      return callsRoute(deps);
    case "sign-in":
      return signInRoute(deps);
    default:
      throw new Error(`Nothing at api/${request.path}`);
  }
}
