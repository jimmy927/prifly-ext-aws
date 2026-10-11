/**
 * An MCP tool every session sees as `mcp__prifly__template_whoami`: which
 * Microsoft account the template would act as, read through
 * `api.connections` — prifly holds the token and adds it to the request, so
 * the extension never keeps one.
 */

import type { ExtensionConnectionsApi, ExtensionTool } from "@prifly/extension-api";

const ME = "https://graph.microsoft.com/v1.0/me";

const NOT_CONNECTED =
  "No Microsoft account is connected for the template: connect one in prifly's Vault → Connections.";

/** The name the account's profile gives, or why there is none. */
async function whoAmI(connections: ExtensionConnectionsApi | undefined): Promise<string> {
  const [first] = connections?.list("microsoft") ?? [];
  if (connections === undefined || first === undefined) return NOT_CONNECTED;
  const answer = await connections.fetch(first.id, ME);
  if ("needsSignIn" in answer) {
    return `The grant for ${answer.needsSignIn.account} ended: sign in again in prifly's Vault → Connections.`;
  }
  if (!answer.ok) return `Microsoft Graph answered ${answer.status} for ${first.account}.`;
  const profile = (await answer.json()) as { displayName?: unknown };
  const name = typeof profile.displayName === "string" ? profile.displayName : first.account;
  return `Signed in as ${name} (${first.account}).`;
}

export function whoAmITool(connections: () => ExtensionConnectionsApi | undefined): ExtensionTool {
  return {
    name: "template_whoami",
    description: "Says which Microsoft account the template extension acts as.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: () => whoAmI(connections()),
  };
}
