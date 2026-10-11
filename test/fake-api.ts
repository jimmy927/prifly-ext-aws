/**
 * A fake of prifly's `api`, for an extension's own tests: everything it is
 * asked to show, log or register is kept to look at, and `api.connections`
 * runs against a fake token endpoint and a fake provider instead of a real
 * account. Copy it into a plugin's `test/` as it is; nothing in it is
 * specific to the template.
 *
 *     const fake = fakeApi({ connections: fakeConnections({ accounts: [ACCOUNT], provider }) });
 *     activate(fake.api);
 *     expect(await fake.callTool("my_tool", {})).toBe("…");
 */

import type {
  Decoration,
  ExtensionApi,
  ExtensionConnection,
  ExtensionConnectionsApi,
  ExtensionFetchOptions,
  ExtensionNeedsSignIn,
  ExtensionPickAnswer,
  ExtensionTool,
  LauncherFlag,
  SettingValues,
} from "@prifly/extension-api";

/** A connected account the fake knows, with the scopes it was granted. */
export type FakeAccount = { id: string; provider: string; account: string; scopes: string[] };

/** The provider's API: what a request with a live token gets back. */
export type FakeProvider = (request: Request) => Response | Promise<Response>;

/**
 * prifly's side of a grant: which access token each connection gets, and
 * which grants the provider ended. `revoke` makes `fetch` and `token` answer
 * `needsSignIn`, as a revoked or expired grant does; `signIn` revives it.
 */
export class FakeTokenEndpoint {
  private readonly issuedCount = new Map<string, number>();
  private readonly ended = new Set<string>();

  /** A fresh token for the connection, or null when its grant ended. */
  issue(connection: string): string | null {
    if (this.ended.has(connection)) return null;
    const count = (this.issuedCount.get(connection) ?? 0) + 1;
    this.issuedCount.set(connection, count);
    return `token-${connection}-${count}`;
  }

  revoke(connection: string): void {
    this.ended.add(connection);
  }

  revive(connection: string): void {
    this.ended.delete(connection);
  }

  isEnded(connection: string): boolean {
    return this.ended.has(connection);
  }

  /** How many tokens the connection was given. */
  issued(connection: string): number {
    return this.issuedCount.get(connection) ?? 0;
  }
}

export type FakeConnections = {
  connections: ExtensionConnectionsApi;
  endpoint: FakeTokenEndpoint;
  accounts: FakeAccount[];
  /** Every request `fetch` sent to the provider, its `Authorization` header set. */
  requests: Request[];
};

const NO_PROVIDER: FakeProvider = () => new Response("no fake provider", { status: 404 });

/**
 * `api.connections` over fake accounts. `provider` answers what `fetch`
 * sends; `scopes` is what the manifest lets `signIn` ask for, by provider
 * (left out, anything). `signIn` with no `connection` connects a new
 * account `<provider>-<n>@example.com`.
 */
export function fakeConnections(
  options: {
    accounts?: FakeAccount[];
    provider?: FakeProvider;
    scopes?: Record<string, string[]>;
  } = {},
): FakeConnections {
  const accounts = [...(options.accounts ?? [])];
  const endpoint = new FakeTokenEndpoint();
  const requests: Request[] = [];
  const provider = options.provider ?? NO_PROVIDER;

  const find = (id: string): FakeAccount => {
    const account = accounts.find((each) => each.id === id);
    if (account === undefined) throw new Error(`No connection ${id}`);
    return account;
  };
  const needsSignIn = (account: FakeAccount): ExtensionNeedsSignIn => ({
    needsSignIn: { connection: account.id, provider: account.provider, account: account.account },
  });
  const view = (account: FakeAccount): ExtensionConnection => ({
    id: account.id,
    provider: account.provider,
    account: account.account,
    client: "prifly",
    scopes: [...account.scopes],
    state: endpoint.isEnded(account.id) ? "needs-sign-in" : "ok",
  });

  const connections: ExtensionConnectionsApi = {
    list: (wanted) =>
      accounts.filter((each) => wanted === undefined || each.provider === wanted).map(view),
    async fetch(id, request, _options?: ExtensionFetchOptions) {
      const account = find(id);
      const token = endpoint.issue(id);
      if (token === null) return needsSignIn(account);
      // Two calls: Bun types a string and a Request as separate overloads of the constructor.
      const sent = typeof request === "string" ? new Request(request) : new Request(request);
      sent.headers.set("Authorization", `Bearer ${token}`);
      requests.push(sent);
      return await provider(new Request(sent));
    },
    async token(id) {
      const account = find(id);
      const token = endpoint.issue(id);
      return token === null ? needsSignIn(account) : { token };
    },
    async signIn(providerName, scopes, signInOptions) {
      const allowed = options.scopes?.[providerName];
      const refused = scopes.filter((scope) => allowed !== undefined && !allowed.includes(scope));
      if (refused.length > 0) {
        return { ok: false, message: `Not in the manifest: ${refused.join(", ")}` };
      }
      const existing = signInOptions?.connection;
      if (existing !== undefined) {
        const account = find(existing);
        account.scopes = [...new Set([...account.scopes, ...scopes])];
        endpoint.revive(existing);
        return { ok: true, connection: account.id, account: account.account };
      }
      const account: FakeAccount = {
        id: `${providerName}-${accounts.length + 1}`,
        provider: providerName,
        account: `${providerName}-${accounts.length + 1}@example.com`,
        scopes: [...scopes],
      };
      accounts.push(account);
      return { ok: true, connection: account.id, account: account.account };
    },
  };
  return { connections, endpoint, accounts, requests };
}

/** What the extension did with the fake api, to look at in a test. */
export type FakeApi = {
  api: ExtensionApi;
  /** The tools of the last `tools.register`. */
  tools: () => ExtensionTool[];
  /** Calls one registered tool the way a session would; the pick card answers `pick`. */
  callTool: (
    name: string,
    args: Record<string, unknown>,
    pick?: ExtensionPickAnswer,
  ) => Promise<string>;
  shown: { bySession: Record<string, Decoration[]>; statusBar: Decoration[] }[];
  flags: Map<string, LauncherFlag | null>;
  notices: { text: string; tone: string | undefined; session: string | undefined }[];
  logs: { event: string; fields: Record<string, unknown> | undefined }[];
};

/** A fake `api`; parts left out of `options` are prifly's quiet defaults. */
export function fakeApi(
  options: {
    connections?: ExtensionConnectionsApi;
    settings?: SettingValues;
    folder?: string;
  } = {},
): FakeApi {
  let tools: ExtensionTool[] = [];
  const fake: Omit<FakeApi, "api" | "tools" | "callTool"> = {
    shown: [],
    flags: new Map(),
    notices: [],
    logs: [],
  };
  const api: ExtensionApi = {
    features: ["settings", "start-session", "session-lookup"],
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.connections === undefined ? {} : { connections: options.connections }),
    tools: {
      register: (given) => {
        tools = given;
      },
    },
    show: (bySession, statusBar) => void fake.shown.push({ bySession, statusBar }),
    snoozeOptions: () => undefined,
    flag: (launchId, flag) => void fake.flags.set(launchId, flag),
    notify: (text, notifyOptions) =>
      void fake.notices.push({ text, tone: notifyOptions?.tone, session: notifyOptions?.session }),
    machines: { report: () => undefined },
    onAction: () => undefined,
    sessions: () => [],
    session: () => null,
    log: (event, fields) => void fake.logs.push({ event, fields }),
    folder: options.folder ?? process.cwd(),
    paths: [],
    cloud: { sessions: async () => [], transcript: async () => [] },
    accounts: () => [],
    prompt: async () => ({ delivered: false }),
    start: async () => ({ started: false, reason: "A fake api starts no session." }),
    snooze: () => undefined,
    dialog: async () => null,
  };
  const callTool: FakeApi["callTool"] = (name, args, pick = null) => {
    const tool = tools.find((each) => each.name === name);
    if (tool === undefined) throw new Error(`No tool ${name} registered`);
    const ctx = {
      session: "fake-session",
      pick: async () => pick,
      signal: new AbortController().signal,
    };
    return tool.call(args, ctx);
  };
  return { api, tools: () => tools, callTool, ...fake };
}
