/** Small files in the extension's own folder: what survives a restart of prifly. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function filePath(folder: string, name: string): string {
  return join(folder, name);
}

/** The JSON in `folder/name`, or `fallback` when it is missing or unreadable. */
export function readJson<T>(folder: string, name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath(folder, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(folder: string, name: string, value: unknown): void {
  const path = filePath(folder, name);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1));
}

/** The UTC day of `ms`, `2026-10-11`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
