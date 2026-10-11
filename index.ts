/**
 * The AWS extension: what prifly imports. `activate` registers the read-only
 * `aws_*` tools and starts the two background reads (alarms every five
 * minutes, Cost Explorer once a day); `choices` and `launch` answer the
 * launcher "AWS", whose board holds the accounts, the cost, the alarms and
 * the day's calls. The extension puts nothing in prifly's status bar and
 * declares no panel. Types come from `@prifly/extension-api` with
 * `import type`, so nothing of it is loaded at run time.
 */

import type {
  ExtensionApi,
  ExtensionConnectionsApi,
  Launch,
  LaunchBoard,
} from "@prifly/extension-api";
import { Accounts, PROVIDER } from "./accounts";
import { AlarmWatch, LAUNCHER, POLL_MS } from "./alarms";
import { CallLog } from "./calls";
import { CostStore } from "./cost";
import { type BoardDeps, board, launchOf, SIGN_IN } from "./launch";
import { awsTools } from "./tools";

const COST_CHECK_MS = 60 * 60 * 1000;

type Running = {
  board: BoardDeps;
  connections: () => ExtensionConnectionsApi | undefined;
  /** Read again after a key was added. */
  afterSignIn: () => void;
};

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
    board: {
      accounts,
      alarms: watch,
      cost,
      calls,
      titleOf: (session) => api.session?.(session)?.title ?? null,
    },
    connections: () => api.connections,
    afterSignIn: () => {
      readAlarms();
      readCosts();
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

/** The launcher `alarms`, the AWS board, narrowed by what the reader typed. */
export function choices(_launchId: string, query: string): Promise<LaunchBoard> {
  return board(current().board, query);
}

/** The session a picked alarm starts; the sign-in row and action open the Add AWS key form. */
export async function launch(_launchId: string, key: string): Promise<Launch> {
  const now = current();
  if (key !== SIGN_IN && !key.startsWith(`${SIGN_IN}:`)) {
    return launchOf(now.board.alarms.alarms(), key);
  }
  const connections = now.connections();
  if (connections === undefined) return { prompt: "", message: "This prifly has no connections." };
  // `aws:sign-in:<id>` revives that key; the bare key opens the Add AWS key form.
  const connection = key.slice(SIGN_IN.length + 1);
  const result = await connections.signIn(
    PROVIDER,
    [],
    connection === "" ? undefined : { connection },
  );
  if (result.ok) now.afterSignIn();
  return {
    prompt: "",
    message: result.ok
      ? "The AWS key is filed: the board fills in once it is read."
      : result.message,
  };
}
