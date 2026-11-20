/**
 * The part of prifly's `api.vault.file` this extension uses: filing a kind
 * `other` entry whose values `produce` makes after the reader clicks File it.
 * Declared here because the installed `@prifly/extension-api` predates it
 * (prifly's "vault-file-values" feature). `vaultFileOf` hands the tools a
 * plain function, or undefined on a prifly that cannot do it.
 */

import type { ExtensionApi } from "@prifly/extension-api";

export type VaultFileRequest = {
  kind: "other";
  /** The environment variable names `produce` returns, shown on the card before anything exists. */
  variables: string[];
  /** Makes the values after the reader clicks File it, never before; a throw files nothing. */
  produce: () => Promise<Record<string, string>>;
  /** What the card says will be created. */
  creates: string;
  label?: string;
  why: string;
};

export type VaultFileResult =
  | { outcome: "accepted"; level: 1 | 2 | 4 }
  | { outcome: "declined" }
  | { outcome: "timed out" }
  | { outcome: "refused"; message: string }
  | { outcome: "failed"; message: string; produced: boolean };

export type VaultFile = (name: string, request: VaultFileRequest) => Promise<VaultFileResult>;

export const NEEDS_UPDATE =
  "Not done: this prifly cannot file an AWS key into the vault. Ask the reader to update prifly.";

/** `api.vault.file` when this prifly has the "vault-file-values" feature, else undefined. */
export function vaultFileOf(api: ExtensionApi): VaultFile | undefined {
  if (api.features?.includes("vault-file-values") !== true) return undefined;
  const vault = api.vault as unknown as { file?: VaultFile } | undefined;
  const file = vault?.file;
  return file === undefined ? undefined : (name, request) => file.call(vault, name, request);
}
