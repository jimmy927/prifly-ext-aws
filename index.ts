/**
 * The template extension: what prifly imports. `activate` is given the api
 * and registers the extension's MCP tool; the other exports answer the
 * launcher (`choices`, `launch`) and the panel (`panel`) the manifest
 * declares. Types come from `@prifly/extension-api` with `import type`, so
 * nothing of it is loaded at run time.
 */

import type { ExtensionApi, Launch, LaunchBoard, PanelRequest } from "@prifly/extension-api";
import { board, launchOf, THINGS } from "./things";
import { whoAmITool } from "./whoami-tool";

let api: ExtensionApi | null = null;

export function activate(given: ExtensionApi): () => void {
  api = given;
  // Absent on an older prifly: optional, like every part added after the first version.
  given.tools?.register([whoAmITool(() => api?.connections)]);
  given.log("activated", { things: THINGS.length });
  return () => {
    api = null;
  };
}

/** The launcher `things`: its board, narrowed by what the reader typed. */
export function choices(_launchId: string, query: string): LaunchBoard {
  return board(query);
}

/** The session a picked thing starts. */
export function launch(_launchId: string, key: string, input: string): Launch {
  return launchOf(key, input);
}

/** What the panel's page asks for at `api/<path>`; answered as JSON. */
export function panel(_panelId: string, request: PanelRequest): unknown {
  if (request.path === "things") return { things: THINGS };
  throw new Error(`Nothing at api/${request.path}`);
}
