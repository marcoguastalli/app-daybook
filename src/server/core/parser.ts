export interface ParsedEntry {
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM; null only for timestamp-less external entries
  content: string;
  wikilinks: string[]; // target titles as written, deduped exact
  /** True when the entry sits under duplicated date or timestamp headings:
   *  logically merged in the index, read-only via the app (409). */
  underDuplicateHeading: boolean;
}

export interface ParsedTopic {
  title: string;
  description: string | null;
  entries: ParsedEntry[]; // in file order
}

export type ParseResult =
  | { ok: true; topic: ParsedTopic }
  | { ok: false; error: string };

export const FENCE_RE = /^ {0,3}```/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d
  );
}

export function isValidTime(s: string): boolean {
  return TIME_RE.test(s);
}

/** Strip leading/trailing blank lines, keep everything in between verbatim. */
function trimBlock(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/** Wikilink titles in the given lines, fence-aware, deduped exact, in order. */
export function extractWikilinks(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(WIKILINK_RE)) {
      const title = m[1]!.trim();
      if (title !== "" && !out.includes(title)) out.push(title);
    }
  }
  return out;
}

/**
 * Structural parser for the fixed topic file format:
 * `# Title`, optional description, `## YYYY-MM-DD` dates, `### HH:MM` entries.
 * Fence-aware: heading and wikilink detection is disabled inside ``` blocks.
 * Malformed files return { ok: false } — they never throw.
 */
export function parseTopicFile(raw: string): ParseResult {
  const lines = raw.replace(/^\uFEFF/, "").split("\n");

  const titleMatch = lines[0]?.match(/^# (.+)$/);
  if (!titleMatch) {
    return { ok: false, error: "first line must be `# <Topic Title>`" };
  }
  const title = titleMatch[1]!.trim();

  interface Block {
    date: string;
    time: string | null;
    lines: string[];
  }

  const descriptionLines: string[] = [];
  const blocks: Block[] = [];
  const dateHeadingCount = new Map<string, number>();
  let current: Block | null = null; // null while in the description region
  let currentDate: string | null = null;
  let inFence = false;

  const route = (line: string) => {
    if (current) current.lines.push(line);
    else descriptionLines.push(line);
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      route(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      const h2 = line.match(/^## (.*)$/);
      if (h2) {
        const date = h2[1]!.trim();
        if (!isValidDate(date)) {
          return { ok: false, error: `invalid date heading: \`## ${h2[1]}\`` };
        }
        dateHeadingCount.set(date, (dateHeadingCount.get(date) ?? 0) + 1);
        currentDate = date;
        // Implicit timestamp-less block; dropped later if it stays empty.
        current = { date, time: null, lines: [] };
        blocks.push(current);
        continue;
      }
      const h3 = line.match(/^### (.*)$/);
      if (h3) {
        if (currentDate === null) {
          return {
            ok: false,
            error: `timestamp heading before any date heading: \`### ${h3[1]}\``,
          };
        }
        const time = h3[1]!.trim();
        if (!isValidTime(time)) {
          return {
            ok: false,
            error: `invalid timestamp heading: \`### ${h3[1]}\` (expected HH:MM)`,
          };
        }
        current = { date: currentDate, time, lines: [] };
        blocks.push(current);
        continue;
      }
    }
    route(line);
  }

  // Merge blocks sharing (date, time) — duplicate headings, external edits.
  const entryMap = new Map<string, ParsedEntry>();
  const order: string[] = [];
  for (const block of blocks) {
    const content = trimBlock(block.lines).join("\n");
    if (block.time === null && content === "") continue; // no timestamp-less entry
    const key = `${block.date}|${block.time ?? ""}`;
    const wikilinks = extractWikilinks(block.lines);
    const existing = entryMap.get(key);
    if (existing) {
      existing.content = existing.content === "" ? content : `${existing.content}\n\n${content}`;
      for (const link of wikilinks) {
        if (!existing.wikilinks.includes(link)) existing.wikilinks.push(link);
      }
      existing.underDuplicateHeading = true;
    } else {
      entryMap.set(key, {
        date: block.date,
        time: block.time,
        content,
        wikilinks,
        underDuplicateHeading: false,
      });
      order.push(key);
    }
  }
  for (const entry of entryMap.values()) {
    if ((dateHeadingCount.get(entry.date) ?? 0) > 1) entry.underDuplicateHeading = true;
  }

  const description = trimBlock(descriptionLines).join("\n");
  return {
    ok: true,
    topic: {
      title,
      description: description === "" ? null : description,
      entries: order.map((key) => entryMap.get(key)!),
    },
  };
}
