/**
 * The things the launch board and the panel show. A real plugin reads them
 * from its service — and keeps what it read, since `choices` is called on
 * every keystroke — where this one has a fixed list.
 */

import type { Launch, LaunchBoard, LaunchChoice } from "@prifly/extension-api";

export type Thing = { key: string; title: string; column: "todo" | "done"; detail: string };

export const THINGS: readonly Thing[] = [
  { key: "t1", title: "Write the first tool", column: "todo", detail: "Register it in activate." },
  { key: "t2", title: "Fill the board", column: "todo", detail: "Answer choices from a cache." },
  { key: "t3", title: "Copy the template", column: "done", detail: "You are here." },
];

/** The launcher's board, narrowed to the things whose title holds `query`. */
export function board(query: string): LaunchBoard {
  const wanted = query.trim().toLowerCase();
  const items: LaunchChoice[] = THINGS.filter((thing) =>
    thing.title.toLowerCase().includes(wanted),
  ).map((thing) => ({
    key: thing.key,
    title: thing.title,
    group: thing.column,
    detail: thing.detail,
  }));
  return {
    columns: [
      { id: "todo", name: "To do" },
      { id: "done", name: "Done" },
    ],
    items,
  };
}

/** The session one thing starts, with what the reader typed into its row. */
export function launchOf(key: string, input: string): Launch {
  const thing = THINGS.find((each) => each.key === key);
  if (thing === undefined) throw new Error(`No thing ${key}`);
  const asked = input.trim() === "" ? "" : `\n\nThe reader adds: ${input.trim()}`;
  return {
    name: thing.title,
    prompt: `Work on "${thing.title}": ${thing.detail}${asked}`,
  };
}
