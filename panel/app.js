// The AWS panel: the filed keys, the month-to-date cost, the alarms in ALARM
// and the calls sessions made today. Each part asks its extension for
// `api/<path>` beside this page (answered by `panel.ts`) and shows its own
// loading, empty and failed state, so one route failing leaves the rest.

import { ago, clock, dayWords, el, money, monthName, pill, when } from "./format.js";

const $ = (id) => document.getElementById(id);

const loading = () => ({ status: "loading", data: null, error: null });
const state = {
  selected: null,
  accounts: loading(),
  cost: loading(),
  alarms: loading(),
  calls: loading(),
  signingIn: false,
  refreshing: false,
  said: null,
};

async function ask(path, init) {
  const response = await fetch(`api/${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/** Fetch into `state[part]`; a failure is kept as that part's error, never thrown. */
async function read(part, path) {
  try {
    state[part] = { status: "ok", data: await ask(path), error: null };
  } catch (caught) {
    state[part] = { status: "error", data: null, error: caught.message };
  }
}

const accountList = () => (state.accounts.status === "ok" ? state.accounts.data.accounts : []);
const selectedAccount = () => accountList().find((each) => each.id === state.selected) ?? null;

function costPath() {
  return state.selected === null ? "cost" : `cost?account=${encodeURIComponent(state.selected)}`;
}

async function loadAll() {
  await read("accounts", "accounts");
  const accounts = accountList();
  if (!accounts.some((each) => each.id === state.selected))
    state.selected = accounts[0]?.id ?? null;
  draw();
  await Promise.all([read("cost", costPath()), read("alarms", "alarms"), read("calls", "calls")]);
  draw();
}

function errorLine(what, error) {
  return el("div", { class: "line" }, `Could not read ${what}: ${error}`);
}

function skeleton(text) {
  return el("div", { class: "skel" }, text);
}

// --- the bar -------------------------------------------------------------

function drawBar() {
  const accounts = accountList();
  const none = accounts.length === 0;
  const group = $("account");
  group.disabled = none;
  group.replaceChildren(
    ...(none
      ? [el("button", { type: "button", disabled: true }, "No account")]
      : accounts.map((each) =>
          el(
            "button",
            {
              type: "button",
              "aria-pressed": String(each.id === state.selected),
              "data-id": each.id,
            },
            each.name,
          ),
        )),
  );
  $("add").disabled = state.signingIn || state.accounts.status === "loading";
  $("addEmpty").disabled = $("add").disabled;
  $("reload").disabled = none || state.refreshing;
  $("stamp").textContent = stampText();
}

function stampText() {
  if (state.accounts.status === "loading") return "Reading AWS…";
  const parts = [];
  const cost = state.cost.data;
  if (cost?.status === "ready") parts.push(`Costs read ${when(cost.entry.readAt)}`);
  const alarms = state.alarms.data;
  if (alarms?.readAt) parts.push(`alarms read ${ago(alarms.readAt)}`);
  return parts.join(" · ");
}

// --- accounts ------------------------------------------------------------

function keyCell(key) {
  if (!key.known) {
    return el("td", {}, "unknown", el("div", { class: "dim" }, key.reason));
  }
  const used = key.lastUsed === null ? "never used" : `used ${ago(key.lastUsed)}`;
  return el(
    "td",
    {},
    "Access key ",
    el("span", { class: "mono" }, key.masked),
    el("div", { class: "dim" }, `${key.ageDays} days old · ${used}`),
  );
}

function statePills(account) {
  if (account.state !== "ok") {
    return [pill("crit", "Sign in again", account.problem ?? undefined)];
  }
  const pills = [pill("ok", "Signed in")];
  if (account.key.known && account.key.rotate)
    pills.push(pill("warn", "Older than 90 days: rotate"));
  return pills;
}

function accountRow(account) {
  return el(
    "tr",
    {},
    el(
      "td",
      {},
      el("strong", {}, account.name),
      el("div", { class: "mono dim" }, account.accountId),
    ),
    el("td", { class: "mono" }, account.identity ?? "–"),
    keyCell(account.key),
    el("td", { class: "mono" }, account.alarmRegions.join(", ") || "–"),
    el("td", {}, ...statePills(account)),
  );
}

function drawAccounts() {
  const part = state.accounts;
  const host = $("accounts");
  if (part.status === "loading") return host.replaceChildren(skeleton("Reading AWS…"));
  if (part.status === "error") return host.replaceChildren(errorLine("the accounts", part.error));
  const head = ["Account", "Identity", "Credential", "Alarm regions", "State"];
  host.replaceChildren(
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...head.map((name) => el("th", {}, name)))),
      el("tbody", {}, ...part.data.accounts.map(accountRow)),
    ),
  );
}

// --- cost ----------------------------------------------------------------

function tile(key, value, sub) {
  return el(
    "div",
    { class: "tile" },
    el("div", { class: "k" }, key),
    el("div", { class: "v" }, value),
    el("div", { class: "s" }, sub),
  );
}

const SHORT = [
  [/^Elastic Compute Cloud.*/, "EC2"],
  [/^Relational Database Service.*/, "RDS"],
  [/^Simple Storage Service.*/, "S3"],
  [/^Simple Notification Service.*/, "SNS"],
  [/^Key Management Service.*/, "KMS"],
];

/** Cost Explorer's service names, shortened the way people say them. */
function shortService(name) {
  const bare = name.replace(/^(Amazon|AWS)\s*/, "");
  const known = SHORT.find(([pattern]) => pattern.test(bare));
  return known ? known[1] : bare;
}

function costTiles(entry, account) {
  const unit = entry.unit;
  const month = monthName(entry.month);
  const top = entry.byService[0];
  const change =
    entry.monthToDate !== null && entry.lastMonthSameDays
      ? Math.round((entry.monthToDate / entry.lastMonthSameDays - 1) * 100)
      : null;
  const period =
    entry.from === null ? month : `${dayWords(entry.from)}–${Number(entry.to.slice(8, 10))}`;
  return [
    tile(`Month to date · ${period}`, money(entry.monthToDate, unit), `${account}, unblended`),
    tile(`Forecast for ${month}`, money(entry.forecast, unit), "Cost Explorer forecast"),
    tile(
      "Same days of last month",
      money(entry.lastMonthSameDays, unit),
      change === null ? "" : `${change >= 0 ? "+" : ""}${change}% this month`,
    ),
    tile(
      "Biggest service",
      top ? shortService(top.service) : "–",
      top && entry.monthToDate
        ? `${money(top.amount, unit)}, ${Math.round((top.amount / entry.monthToDate) * 100)}% of the month`
        : "",
    ),
  ];
}

function placeholderTiles(text) {
  return ["Month to date", "Forecast", "Same days of last month", "Biggest service"].map((key) =>
    tile(key, "–", text),
  );
}

function costNote(title, text) {
  return el("div", { class: "note" }, el("strong", {}, title), text);
}

function drawTiles() {
  const part = state.cost;
  const host = $("tiles");
  const data = part.data;
  if (part.status === "loading") return host.replaceChildren(...placeholderTiles("Reading AWS…"));
  if (part.status === "error") return host.replaceChildren(errorLine("the cost", part.error));
  if (data.status === "note") {
    return host.replaceChildren(costNote("Cost figures are off for this account", data.note));
  }
  if (data.status === "sign-in") {
    return host.replaceChildren(costNote("This key needs signing in again", data.message));
  }
  if (data.status === "ready") return host.replaceChildren(...costTiles(data.entry, data.name));
  host.replaceChildren(...placeholderTiles(data.status === "pending" ? "Not read yet today" : ""));
}

function barRows(entry) {
  const unit = entry.unit;
  const top = entry.byService.slice(0, 5);
  const rest = entry.byService.slice(5).reduce((sum, row) => sum + row.amount, 0);
  const rows = [...top.map((row) => ({ name: shortService(row.service), amount: row.amount }))];
  if (rest > 0) rows.push({ name: "Everything else", amount: rest, dim: true });
  const biggest = Math.max(...rows.map((row) => row.amount), 1);
  return rows.flatMap((row) => [
    el("span", { class: row.dim ? "dim" : false }, row.name),
    el(
      "div",
      { class: "track" },
      el("div", {
        class: "fill",
        style: `width: ${Math.max(1, (row.amount / biggest) * 100)}%${row.dim ? "; opacity: 0.45" : ""}`,
      }),
    ),
    el("span", { class: "num" }, money(row.amount, unit)),
  ]);
}

function drawCost() {
  const part = state.cost;
  const data = part.data;
  const sub = $("costSub");
  const host = $("cost");
  if (part.status === "loading") {
    sub.textContent = "";
    return host.replaceChildren(skeleton("Reading AWS…"));
  }
  if (part.status === "error") {
    sub.textContent = "";
    return host.replaceChildren(errorLine("the cost", part.error));
  }
  sub.textContent = "Read once a day from Cost Explorer, which charges $0.01 per call.";
  if (data.status !== "ready") {
    const says = {
      note: "Cost Explorer is off for this account, see the note above.",
      "sign-in": "The key needs signing in again.",
      pending: "Not read yet today. The extension reads it once a day.",
      "no-key": "No key is filed.",
    };
    return host.replaceChildren(el("div", { class: "dim" }, says[data.status] ?? ""));
  }
  const reads = data.entry.reads;
  sub.textContent = `Read once a day from Cost Explorer, which charges $0.01 per call: ${reads} call${reads === 1 ? "" : "s"} this month.`;
  host.replaceChildren(
    data.entry.byService.length === 0
      ? el("div", { class: "dim" }, "No cost recorded yet this month.")
      : el("div", { class: "bars" }, ...barRows(data.entry)),
  );
}

// --- alarms --------------------------------------------------------------

function alarmRow(alarm) {
  return el(
    "tr",
    {},
    el("td", {}, pill("crit", "ALARM"), alarm.name),
    el("td", { class: "mono" }, alarm.region),
    el("td", {}, when(alarm.since)),
  );
}

function drawAlarms() {
  const part = state.alarms;
  const host = $("alarms");
  const sub = $("alarmsSub");
  const account = selectedAccount();
  sub.textContent = account
    ? `The regions of ${account.name} that have alarms, read every 5 minutes. A session can start from one in the AWS alarms launcher.`
    : "";
  if (part.status === "loading") return host.replaceChildren(skeleton("Reading AWS…"));
  if (part.status === "error") return host.replaceChildren(errorLine("the alarms", part.error));
  const problems = part.data.problems.filter((each) => each.account === state.selected);
  const mine = part.data.alarms.filter((each) => each.account === state.selected);
  const notes = problems.map((each) => el("div", { class: "line" }, each.problem));
  if (part.data.readAt === null) return host.replaceChildren(skeleton("Reading alarms…"), ...notes);
  if (mine.length === 0) {
    return host.replaceChildren(el("div", { class: "dim" }, "No alarm is in ALARM."), ...notes);
  }
  host.replaceChildren(
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...["Alarm", "Region", "Since"].map((n) => el("th", {}, n)))),
      el("tbody", {}, ...mine.map(alarmRow)),
    ),
    ...notes,
  );
}

// --- calls ---------------------------------------------------------------

const KINDS = { read: "ok", refused: "warn", failed: "crit", "sign-in": "crit" };

function callRow(call) {
  return el(
    "tr",
    {},
    el("td", {}, clock(call.at)),
    el(
      "td",
      {},
      call.sessionTitle ?? "session ",
      " ",
      el("span", { class: "mono dim" }, call.sessionShort),
    ),
    el("td", { class: "mono" }, `${call.service} ${call.action}`),
    el("td", { class: "mono" }, call.region),
    el("td", {}, pill(KINDS[call.kind] ?? "warn", call.outcome)),
  );
}

function drawCalls() {
  const part = state.calls;
  const host = $("calls");
  if (part.status === "loading") return host.replaceChildren(skeleton("Reading AWS…"));
  if (part.status === "error") return host.replaceChildren(errorLine("the calls", part.error));
  if (part.data.calls.length === 0) {
    return host.replaceChildren(el("div", { class: "dim" }, "No calls from sessions today."));
  }
  const head = ["Time", "Session", "Call", "Region", "Outcome"];
  host.replaceChildren(
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...head.map((name) => el("th", {}, name)))),
      el("tbody", {}, ...part.data.calls.map(callRow)),
    ),
  );
}

// --- the whole page ------------------------------------------------------

function draw() {
  const empty = state.accounts.status === "ok" && accountList().length === 0;
  $("empty").hidden = !empty;
  $("main").hidden = empty;
  const said = $("said");
  said.hidden = state.said === null;
  said.textContent = state.said ?? "";
  drawBar();
  drawAccounts();
  drawTiles();
  drawCost();
  drawAlarms();
  drawCalls();
}

async function addKey() {
  state.signingIn = true;
  state.said = null;
  draw();
  try {
    const result = await ask("sign-in", { method: "POST", body: "{}" });
    if (result.ok === false) state.said = result.message;
  } catch (caught) {
    state.said = `Could not open the Add AWS key form: ${caught.message}`;
  }
  state.signingIn = false;
  await loadAll();
}

async function refreshAlarms() {
  state.refreshing = true;
  draw();
  await read("alarms", "alarms?refresh=1");
  state.refreshing = false;
  draw();
}

$("account").addEventListener("click", async (event) => {
  const id = event.target.closest("button")?.dataset.id;
  if (id === undefined || id === state.selected) return;
  state.selected = id;
  state.cost = loading();
  draw();
  await read("cost", costPath());
  draw();
});
$("add").addEventListener("click", addKey);
$("addEmpty").addEventListener("click", addKey);
$("reload").addEventListener("click", refreshAlarms);

const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};
addEventListener("message", (event) => {
  if (event.data?.type !== "prifly-look") return;
  document.documentElement.classList.toggle("dark", event.data.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = event.data.tokens?.[theirs];
    if (typeof value === "string" && value !== "") {
      document.documentElement.style.setProperty(ours, value);
    }
  }
});

draw();
void loadAll();
// Alarms and the day's calls follow the extension's five-minute poll while the panel is open.
setInterval(() => {
  void read("alarms", "alarms").then(draw);
  void read("calls", "calls").then(draw);
}, 60_000);
