/**
 * Just enough XML: a fact cut out of a Query reply with a small regex (who a
 * key is), and the escaping a rest-xml request body needs. Everything else is
 * handed to the session as the text AWS sent. No parser dependency.
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

/** `text` safe inside an element or a double-quoted attribute. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The text of the first `<name>…</name>` in `xml`, decoded; null when there is none. */
export function tag(xml: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return found?.[1] === undefined ? null : decode(found[1].trim());
}
