/**
 * The one line Settings → Extensions shows for the extension (`api.status`):
 * who the first filed key is, from STS GetCallerIdentity.
 */

import { type Accounts, NEEDS_SIGN_IN } from "./accounts";

/** How often the line is read again. */
export const STATUS_MS = 15 * 60 * 1000;

/** "Connected · account 123456789012 (prifly)", or what stands in the way. */
export async function statusLine(accounts: Accounts): Promise<string> {
  const all = accounts.list();
  const first = all[0];
  if (first === undefined) return "No AWS key filed · add one in Vault → Connections";
  const identity = await accounts.identity(first);
  if (identity === NEEDS_SIGN_IN)
    return "AWS key needs signing in · re-add it in Vault → Connections";
  if (typeof identity === "string") return `Not connected · ${identity}`;
  const user = identity.who.replace(/^user\//, "");
  const more = all.length > 1 ? ` · ${all.length} keys` : "";
  return `Connected · account ${identity.account} (${user})${more}`;
}
