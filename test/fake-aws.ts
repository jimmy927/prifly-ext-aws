/**
 * A fake AWS behind a fake `aws-keys` connection: canned XML and JSON by
 * `service:Action`, the way the plugin's requests name them. Everything the
 * plugin sent is in `connections.sent`, with the region and service prifly
 * would have signed for.
 */

import type { FakeAccount, FakeConnections } from "./fake-api";
import { fakeConnections } from "./fake-api";

export const KEY: FakeAccount = {
  id: "aws-1",
  provider: "aws-keys",
  account: "artemis-prod (4821-0937-1150)",
  scopes: [],
};

export const SECOND: FakeAccount = {
  id: "aws-2",
  provider: "aws-keys",
  account: "morpheus-sandbox (2290-4471-8836)",
  scopes: [],
};

export type Canned = Response | ((request: Request, body: string) => Response);

export const xml = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/xml" } });

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/x-amz-json-1.1" },
  });

export const xmlError = (code: string, message: string, status = 403): Response =>
  xml(
    `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
    status,
  );

export const jsonError = (code: string, message: string, status = 400): Response =>
  json({ __type: `com.amazon.coral#${code}`, message }, status);

export const IDENTITY = xml(
  "<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::482109371150:user/prifly</Arn><UserId>AIDAEXAMPLE</UserId><Account>482109371150</Account></GetCallerIdentityResult></GetCallerIdentityResponse>",
);

/**
 * `service:Action` of a Query or JSON request, from its host, target header or
 * form body; `METHOD host/path` of a REST one ("PUT my-bucket.s3.eu-north-1.amazonaws.com/").
 */
export function keyOf(request: Request, body: string): string {
  const url = new URL(request.url);
  const host = url.hostname.split(".")[0] ?? "";
  const target = request.headers.get("x-amz-target");
  if (target !== null) return `${host}:${target.split(".").pop()}`;
  const action = new URLSearchParams(body).get("Action");
  if (action !== null) return `${host === "monitoring" ? "cloudwatch" : host}:${action}`;
  return `${request.method} ${url.hostname}${url.pathname}`;
}

/** The fake connections with one or two keys, answering from `table` (unknown calls get a 404). */
export function fakeAws(
  table: Record<string, Canned>,
  accounts: FakeAccount[] = [KEY],
): FakeConnections {
  return fakeConnections({
    accounts,
    provider: async (request) => {
      const body = await request.clone().text();
      const canned = table[keyOf(request, body)];
      if (canned === undefined)
        return xmlError("NotCanned", `No canned answer for ${keyOf(request, body)}`, 404);
      if (typeof canned === "function") return canned(request, body);
      // A Response can be read once: answer each call with a copy.
      return new Response(await canned.clone().text(), {
        status: canned.status,
        headers: [...canned.headers.entries()],
      });
    },
  });
}
