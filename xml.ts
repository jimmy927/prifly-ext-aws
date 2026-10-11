/**
 * Just enough XML for the Query protocol's replies: the few facts the panel
 * needs are cut out with small regexes, and everything else is handed to the
 * session as the text AWS sent. No parser dependency.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** The text of the first `<name>…</name>` in `xml`, decoded; null when there is none. */
export function tag(xml: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return found?.[1] === undefined ? null : decode(found[1].trim());
}

/** The inside of the first `<name>…</name>`, as it is (nested tags kept); null when there is none. */
export function inner(xml: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return found?.[1] ?? null;
}

/**
 * The top-level `<member>…</member>` elements of `xml` (a list's inside), as
 * their inner text. Members nested in a member (a dimension list in an alarm)
 * stay inside their parent.
 */
export function members(xml: string): string[] {
  const out: string[] = [];
  const edge = /<(\/?)member>/g;
  let depth = 0;
  let start = 0;
  for (let found = edge.exec(xml); found !== null; found = edge.exec(xml)) {
    if (found[1] === "") {
      if (depth === 0) start = found.index + found[0].length;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) out.push(xml.slice(start, found.index));
    }
  }
  return out;
}
