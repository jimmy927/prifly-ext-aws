/**
 * The AWS extension: what prifly imports. `activate` registers the read-only
 * `aws_*` tools and starts the two background reads (alarms every five
 * minutes, Cost Explorer once a day); `choices` and `launch` answer the
 * launcher "AWS alarms", `panel` the AWS panel. Types come from
 * `@prifly/extension-api` with `import type`, so nothing of it is loaded at
 * run time.
 */

import type { ExtensionApi, Launch, LaunchBoard, PanelRequest } from "@prifly/extension-api";
import { Accounts } from "./accounts";
import { AlarmWatch, LAUNCHER, POLL_MS } from "./alarms";
import { CallLog } from "./calls";
import { CostStore } from "./cost";
import { board, launchOf } from "./launch";
import { answer, type PanelDeps } from "./panel";
import { awsTools } from "./tools";

const COST_CHECK_MS = 60 * 60 * 1000;

type Running = { watch: AlarmWatch; panel: PanelDeps };

let running: Running | null = null;

export function activate(api: ExtensionApi): () => void {
  const now = Date.now;
  const accounts = new Accounts(() => api.connections, now);
  const calls = new CallLog(api.folder, now);
  const cost = new CostStore(api.folder, accounts);
  const watch = new AlarmWatch(api.folder, accounts, (flag) => api.flag(LAUNCHER, flag));
  const logFailure = (event: string) => (error: unknown) =>
    api.log(event, { message: error instanceof Error ? error.message : String(error) });
  const readAlarms = () => void watch.poll().catch(logFailure("alarms_failed"));
  const readCosts = () => void cost.refreshAll().catch(logFailure("cost_failed"));
  running = {
    watch,
    panel: {
      accounts,
      alarms: watch,
      cost,
      calls,
      connections: () => api.connections,
      titleOf: (session) => api.session?.(session)?.title ?? null,
      afterSignIn: () => {
        readAlarms();
        readCosts();
      },
    },
  };
  // Absent on an older prifly: optional, like every part added after the first version.
  api.tools?.register(awsTools({ accounts, calls, cost, now }));
  readAlarms();
  readCosts();
  const timers = [setInterval(readAlarms, POLL_MS), setInterval(readCosts, COST_CHECK_MS)];
  api.log("activated", { connections: api.connections === undefined ? "absent" : "present" });
  return () => {
    for (const timer of timers) clearInterval(timer);
    running = null;
  };
}

function current(): Running {
  if (running === null) throw new Error("The AWS extension is not running.");
  return running;
}

/** The launcher `alarms`: the alarms in ALARM now, narrowed by what the reader typed. */
export function choices(_launchId: string, query: string): LaunchBoard {
  return board(current().watch.alarms(), query);
}

/** The session a picked alarm starts. */
export function launch(_launchId: string, key: string): Launch {
  return launchOf(current().watch.alarms(), key);
}

/** What the panel's page asks for at `api/<path>`; answered as JSON. */
export function panel(_panelId: string, request: PanelRequest): unknown {
  return answer(current().panel, request);
}
