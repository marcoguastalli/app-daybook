/** Local "today" as YYYY-MM-DD — the server's TZ decides file placement,
 *  the browser's local date only preselects the daily view. */
export function todayISO(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** DOM id for an entry card, so search results can deep-link and scroll
 *  to the exact entry inside the topic view. */
export function entryAnchor(date: string, time: string | null): string {
  return `e-${date}-${time?.replace(":", "") ?? "loose"}`;
}
