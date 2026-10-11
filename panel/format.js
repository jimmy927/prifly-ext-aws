// Small helpers for the AWS panel: building elements (no innerHTML, so an
// alarm's name can never be markup), money and times in words.

/** An element with attributes and children (strings become text). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== false && value !== null && value !== undefined) {
      node.setAttribute(name, value === true ? "" : value);
    }
  }
  node.append(
    ...children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  );
  return node;
}

export function pill(kind, text, title) {
  return el("span", { class: `pill ${kind}`, title: title ?? false }, text);
}

export function money(amount, unit = "USD") {
  if (typeof amount !== "number") return "–";
  const whole = Math.abs(amount) >= 1000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: unit,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-01` as "Oct 1". */
export function dayWords(day) {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}

export function monthName(month) {
  return MONTHS[Number(month.slice(5, 7)) - 1];
}

const pad = (n) => String(n).padStart(2, "0");

/** "07:41 today", "yesterday 22:10", "9 Oct 22:10" (the reader's own time). */
export function when(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
      new Date(at.getFullYear(), at.getMonth(), at.getDate())) /
      86_400_000,
  );
  if (days === 0) return `${time} today`;
  if (days === 1) return `yesterday ${time}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${time}`;
}

export function clock(iso) {
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** "2 min ago", "yesterday". */
export function ago(iso, now = new Date()) {
  const seconds = Math.max(0, Math.round((now - new Date(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  const days = Math.round(seconds / 86_400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
