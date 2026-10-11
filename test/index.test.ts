import { afterEach, expect, test } from "bun:test";
import type { ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

const ACCOUNT: FakeAccount = {
  id: "ms-1",
  provider: "microsoft",
  account: "ada@example.com",
  scopes: ["User.Read"],
};

/** Microsoft Graph's `/me`, as far as the tool reads it. */
const graph = (request: Request) =>
  new URL(request.url).pathname === "/v1.0/me"
    ? Response.json({ displayName: "Ada Lovelace" })
    : new Response("not found", { status: 404 });

let stop: (() => void) | undefined;
afterEach(() => stop?.());

async function activated(connections?: ReturnType<typeof fakeConnections>) {
  const fake = fakeApi(connections === undefined ? {} : { connections: connections.connections });
  stop = (await module.activate(fake.api)) ?? undefined;
  return fake;
}

test("activate registers the whoami tool", async () => {
  const fake = await activated();
  expect(fake.tools().map((tool) => tool.name)).toEqual(["template_whoami"]);
  expect(fake.logs).toEqual([{ event: "activated", fields: { things: 3 } }]);
});

test("the tool says to connect an account when none is", async () => {
  const fake = await activated(fakeConnections());
  expect(await fake.callTool("template_whoami", {})).toContain("No Microsoft account is connected");
});

test("the tool reads the profile with the connection's token", async () => {
  const connections = fakeConnections({ accounts: [ACCOUNT], provider: graph });
  const fake = await activated(connections);
  expect(await fake.callTool("template_whoami", {})).toBe(
    "Signed in as Ada Lovelace (ada@example.com).",
  );
  expect(connections.requests.map((request) => request.headers.get("Authorization"))).toEqual([
    "Bearer token-ms-1-1",
  ]);
});

test("a grant the provider ended is passed on as a sign-in, and signIn revives it", async () => {
  const connections = fakeConnections({ accounts: [ACCOUNT], provider: graph });
  const fake = await activated(connections);
  connections.endpoint.revoke("ms-1");
  expect(await fake.callTool("template_whoami", {})).toContain("sign in again");
  expect(connections.connections.list()).toMatchObject([{ state: "needs-sign-in" }]);

  expect(
    await connections.connections.signIn("microsoft", ["User.Read"], { connection: "ms-1" }),
  ).toEqual({ ok: true, connection: "ms-1", account: "ada@example.com" });
  expect(await fake.callTool("template_whoami", {})).toContain("Ada Lovelace");
});

test("signIn asks only for what the manifest lists", async () => {
  const { connections } = fakeConnections({ scopes: { microsoft: ["User.Read"] } });
  expect(await connections.signIn("microsoft", ["Mail.Send"])).toEqual({
    ok: false,
    message: "Not in the manifest: Mail.Send",
  });
  expect(await connections.signIn("microsoft", ["User.Read"])).toMatchObject({ ok: true });
  expect(connections.list("microsoft")).toHaveLength(1);
});

test("the launcher's board has both columns and narrows to what is typed", async () => {
  await activated();
  const board = await module.choices?.("things", "tool");
  expect(board).toEqual({
    columns: [
      { id: "todo", name: "To do" },
      { id: "done", name: "Done" },
    ],
    items: [
      {
        key: "t1",
        title: "Write the first tool",
        group: "todo",
        detail: "Register it in activate.",
      },
    ],
  });
});

test("a picked thing launches a session carrying what the reader typed", async () => {
  await activated();
  const launch = await module.launch?.("things", "t2", "  start with Trello ", { again: false });
  expect(launch).toEqual({
    name: "Fill the board",
    prompt:
      'Work on "Fill the board": Answer choices from a cache.\n\nThe reader adds: start with Trello',
  });
});

test("the panel answers its page's api/things, and refuses what it does not have", async () => {
  await activated();
  const answer = module.panel?.("things", { path: "things", query: {}, body: null });
  expect(answer).toMatchObject({ things: [{ key: "t1" }, { key: "t2" }, { key: "t3" }] });
  expect(() => module.panel?.("things", { path: "nope", query: {}, body: null })).toThrow(
    "Nothing at api/nope",
  );
});
