import { chmod, rename } from "node:fs/promises";
import { FENCE_RE, type ParsedTopic } from "./parser";

export class EntryNotFoundError extends Error {}

/** Topic files are meant to be edited outside the app too (vim, VS Code).
 *  The app writes them as a non-root container user, so on Linux — where
 *  bind mounts pass ownership straight through — a default 0644 would leave
 *  them read-only for the human editing by hand. Group-writable keeps both
 *  writers working when the directory is group-shared (see README setup). */
const TOPIC_FILE_MODE = 0o664;

/** Write temp file + rename in the same directory, so a crash can never
 *  leave a half-written topic file. */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, content);
  // chmod before the rename: the file is never visible at the final path
  // with the wrong mode.
  await chmod(tmp, TOPIC_FILE_MODE);
  await rename(tmp, path);
}

export function createTopicFile(title: string): string {
  return `# ${title}\n`;
}

interface HeadingPos {
  line: number;
  level: 2 | 3;
  value: string;
}

/** All H2/H3 headings with their line numbers, fence-aware. */
function scanHeadings(lines: string[]): HeadingPos[] {
  const out: HeadingPos[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h2 = line.match(/^## (.*)$/);
    if (h2) {
      out.push({ line: i, level: 2, value: h2[1]!.trim() });
      continue;
    }
    const h3 = line.match(/^### (.*)$/);
    if (h3) out.push({ line: i, level: 3, value: h3[1]!.trim() });
  }
  return out;
}

function toLines(content: string): string[] {
  const lines = content.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function fromLines(lines: string[]): string {
  return lines.join("\n") + "\n";
}

function textToLines(text: string): string[] {
  return text.replace(/\s+$/, "").split("\n");
}

/** Join fragments with exactly one blank line at each non-empty seam. */
function joinBlocks(...fragments: string[][]): string[] {
  const out: string[] = [];
  for (const fragment of fragments) {
    if (fragment.length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(...fragment);
  }
  return out;
}

/** Strip blank lines at both edges of a fragment. */
function trimEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/** Insert a block at line `at` (a heading line, or lines.length for EOF). */
function insertBlock(lines: string[], at: number, block: string[]): string[] {
  return joinBlocks(trimEdges(lines.slice(0, at)), block, trimEdges(lines.slice(at)));
}

/** Remove lines [from, to), keeping single-blank-line seams around the cut. */
function removeRange(lines: string[], from: number, to: number): string[] {
  return joinBlocks(trimEdges(lines.slice(0, from)), trimEdges(lines.slice(to)));
}

interface DateSection {
  heading: HeadingPos;
  end: number; // exclusive: next H2 line or lines.length
  h3s: HeadingPos[];
}

/** First occurrence of the date's section (app writes always target it). */
function findDateSection(lines: string[], date: string): DateSection | null {
  const heads = scanHeadings(lines);
  const h2s = heads.filter((h) => h.level === 2);
  const heading = h2s.find((h) => h.value === date);
  if (!heading) return null;
  const next = h2s.find((h) => h.line > heading.line);
  const end = next ? next.line : lines.length;
  const h3s = heads.filter((h) => h.level === 3 && h.line > heading.line && h.line < end);
  return { heading, end, h3s };
}

/** End of the block opened by the heading at `headingLine`: the next heading
 *  of any level, or the section/file end. */
function blockEnd(lines: string[], headingLine: number, sectionEnd: number): number {
  const next = scanHeadings(lines).find((h) => h.line > headingLine && h.line < sectionEnd);
  return next ? next.line : sectionEnd;
}

/**
 * Insert an entry at the correct descending position. Existing `### time`
 * block on the same date → the text is appended into it (same-minute rule).
 * Timestamp-less content stays anchored directly under its date heading:
 * new `###` blocks always land after it.
 */
export function addEntry(content: string, date: string, time: string, text: string): string {
  const lines = toLines(content);
  const textLines = textToLines(text);
  const section = findDateSection(lines, date);

  if (!section) {
    const h2s = scanHeadings(lines).filter((h) => h.level === 2);
    const before = h2s.find((h) => h.value < date); // ISO dates: string compare
    const at = before ? before.line : lines.length;
    return fromLines(
      insertBlock(lines, at, [`## ${date}`, "", `### ${time}`, "", ...textLines]),
    );
  }

  const same = section.h3s.find((h) => h.value === time);
  if (same) {
    const end = blockEnd(lines, same.line, section.end);
    return fromLines(insertBlock(lines, end, textLines));
  }

  // Descending among ### blocks; timestamp-less content (which sits between
  // the ## heading and the first ###) is never jumped over.
  const before = section.h3s.find((h) => h.value < time);
  const at = before ? before.line : section.end;
  return fromLines(insertBlock(lines, at, [`### ${time}`, "", ...textLines]));
}

/** Locate the entry's block. time === null addresses the timestamp-less
 *  region under the date heading — it stays timestamp-less: no `###` is
 *  ever added to it. `start` is the line after the block's heading. */
function entryRange(
  lines: string[],
  date: string,
  time: string | null,
): { section: DateSection; headingLine: number; start: number; end: number } {
  const section = findDateSection(lines, date);
  if (!section) throw new EntryNotFoundError(`no date heading \`## ${date}\``);
  if (time === null) {
    const end = section.h3s.length > 0 ? section.h3s[0]!.line : section.end;
    const loose = lines.slice(section.heading.line + 1, end);
    if (trimEdges(loose).length === 0) {
      throw new EntryNotFoundError(`no timestamp-less entry under \`## ${date}\``);
    }
    return { section, headingLine: section.heading.line, start: section.heading.line + 1, end };
  }
  const h3 = section.h3s.find((h) => h.value === time);
  if (!h3) throw new EntryNotFoundError(`no entry \`### ${time}\` under \`## ${date}\``);
  return {
    section,
    headingLine: h3.line,
    start: h3.line + 1,
    end: blockEnd(lines, h3.line, section.end),
  };
}

export function editEntry(
  content: string,
  date: string,
  time: string | null,
  newText: string,
): string {
  const lines = toLines(content);
  const { start, end } = entryRange(lines, date, time);
  return fromLines(
    joinBlocks(lines.slice(0, start), textToLines(newText), trimEdges(lines.slice(end))),
  );
}

/**
 * Delete an entry. Removes the `### HH:MM` heading when its last content
 * goes; removes the `## date` heading when the date has nothing left. The
 * topic file itself is never deleted — with zero entries only `# Title` stays.
 */
export function deleteEntry(content: string, date: string, time: string | null): string {
  let lines = toLines(content);
  const { headingLine, start, end } = entryRange(lines, date, time);

  // Timestamp-less: remove only the content, keep the ## heading for now.
  // Timed: remove the ### heading together with its content.
  lines = removeRange(lines, time === null ? start : headingLine, end);

  // Drop the ## heading if the date section is now empty.
  const after = findDateSection(lines, date);
  if (after) {
    const loose = lines.slice(after.heading.line + 1, after.end);
    if (after.h3s.length === 0 && trimEdges(loose).length === 0) {
      lines = removeRange(lines, after.heading.line, after.end);
    }
  }
  return fromLines(lines);
}

/** Canonical full-file emission: used for topic creation and the round-trip
 *  tests — incremental app writes go through add/edit/deleteEntry instead,
 *  which preserve structure the app did not create. */
export function serializeTopic(topic: ParsedTopic): string {
  const out: string[] = [`# ${topic.title}`];
  if (topic.description) out.push("", topic.description);

  const dates = [...new Set(topic.entries.map((e) => e.date))].sort().reverse();
  for (const date of dates) {
    out.push("", `## ${date}`);
    const ofDate = topic.entries.filter((e) => e.date === date);
    const loose = ofDate.find((e) => e.time === null);
    if (loose && loose.content !== "") out.push("", loose.content);
    const timed = ofDate
      .filter((e) => e.time !== null)
      .sort((a, b) => (a.time! < b.time! ? 1 : -1));
    for (const entry of timed) {
      out.push("", `### ${entry.time}`);
      if (entry.content !== "") out.push("", entry.content);
    }
  }
  return out.join("\n") + "\n";
}
