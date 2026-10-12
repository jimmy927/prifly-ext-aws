/**
 * The call log: every `aws_call` a session made, refusals included, one JSON
 * line each in `calls.jsonl` of the extension's folder, kept 30 days. The
 * board's "Calls from sessions today" section reads it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { filePath } from "./store";

export const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How a call ended: a read, a refusal, a failure on AWS's side, a key to look at. */
export type CallKind = "read" | "refused" | "failed" | "sign-in";

export type CallEntry = {
  /** ISO time. */
  at: string;
  session: string;
  account: string;
  service: string;
  action: string;
  region: string;
  kind: CallKind;
  /** The words for the board: "Read", "Refused: read-only", "Failed: AccessDenied". */
  outcome: string;
};

const FILE = "calls.jsonl";

function parse(line: string): CallEntry | null {
  try {
    const entry = JSON.parse(line) as CallEntry;
    return typeof entry.at === "string" ? entry : null;
  } catch {
    return null;
  }
}

export class CallLog {
  private readonly folder: string;
  private readonly now: () => number;
  private pruned = 0;

  constructor(folder: string, now: () => number = Date.now) {
    this.folder = folder;
    this.now = now;
  }

  /** Every entry still kept, oldest first. */
  all(): CallEntry[] {
    try {
      return readFileSync(filePath(this.folder, FILE), "utf8")
        .split("\n")
        .flatMap((line) => (line === "" ? [] : [parse(line)]))
        .filter((entry): entry is CallEntry => entry !== null);
    } catch {
      return [];
    }
  }

  append(entry: CallEntry): void {
    const path = filePath(this.folder, FILE);
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    this.prune();
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  }

  /** Entries since the local midnight, newest first. */
  today(): CallEntry[] {
    const midnight = new Date(this.now());
    midnight.setHours(0, 0, 0, 0);
    return this.all()
      .filter((entry) => Date.parse(entry.at) >= midnight.getTime())
      .reverse();
  }

  /** Drop what is older than 30 days; at most once an hour. */
  prune(): void {
    if (this.now() - this.pruned < 60 * 60 * 1000) return;
    this.pruned = this.now();
    const all = this.all();
    const kept = all.filter((entry) => Date.parse(entry.at) >= this.now() - KEEP_DAYS * DAY_MS);
    if (kept.length === all.length) return;
    writeFileSync(
      filePath(this.folder, FILE),
      kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }
}
