/**
 * The AWS extension: what prifly imports. `activate` registers the `aws_*`
 * tools, keeps the one status line of Settings → Extensions current (every
 * 15 minutes) and reads Cost Explorer once a day for `aws_cost`. No board,
 * launcher, flag or status-bar item: sessions use the tools. Types come from
 * `@prifly/extension-api` with `import type`, so nothing of it is loaded at
 * run time.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { Accounts } from "./accounts";
import { CostStore } from "./cost";
import { Models } from "./models";
import { STATUS_MS, statusLine } from "./status";
import { awsTools } from "./tools";

const COST_CHECK_MS = 60 * 60 * 1000;

export function activate(api: ExtensionApi): () => void {
  const accounts = new Accounts(() => api.connections, Date.now, new Models());
  const cost = new CostStore(api.folder, accounts);
  const logFailure = (event: string) => (error: unknown) =>
    api.log(event, { message: error instanceof Error ? error.message : String(error) });
  const readCosts = () => void cost.refreshAll().catch(logFailure("cost_failed"));
  const readStatus = () =>
    void statusLine(accounts)
      .then((line) => api.status?.(line))
      .catch(logFailure("status_failed"));
  const confirm = api.confirm?.bind(api);
  // Absent on an older prifly: optional, like every part added after the first version.
  api.tools?.register(
    awsTools({
      accounts,
      cost,
      ...(confirm === undefined ? {} : { confirm }),
      log: (event, fields) => api.log(event, fields),
    }),
  );
  readCosts();
  readStatus();
  const timers = [setInterval(readCosts, COST_CHECK_MS), setInterval(readStatus, STATUS_MS)];
  api.log("activated", { connections: api.connections === undefined ? "absent" : "present" });
  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
