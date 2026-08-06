import { describe, expect, it } from "bun:test";
import { parseTopicFile } from "../../src/server/core/parser";

function parseOk(raw: string) {
  const result = parseTopicFile(raw);
  if (!result.ok) throw new Error(`expected ok parse, got: ${result.error}`);
  return result.topic;
}

describe("parseTopicFile", () => {
  it("parses title, dates, timestamps and content", () => {
    const topic = parseOk(
      "# My Topic\n\n## 2026-08-04\n\n### 18:30\n\nhello world\n\n### 09:15\n\nearlier\n\n## 2026-08-01\n\n### 22:00\n\nfirst\n",
    );
    expect(topic.title).toBe("My Topic");
    expect(topic.description).toBeNull();
    expect(topic.entries).toEqual([
      { date: "2026-08-04", time: "18:30", content: "hello world", wikilinks: [], underDuplicateHeading: false },
      { date: "2026-08-04", time: "09:15", content: "earlier", wikilinks: [], underDuplicateHeading: false },
      { date: "2026-08-01", time: "22:00", content: "first", wikilinks: [], underDuplicateHeading: false },
    ]);
  });

  it("captures the description between title and first date heading", () => {
    const topic = parseOk("# T\n\nSome description.\nSecond line.\n\n## 2026-01-01\n\n### 10:00\n\nx\n");
    expect(topic.description).toBe("Some description.\nSecond line.");
  });

  it("a title-only file has no description and no entries", () => {
    const topic = parseOk("# Minimal\n");
    expect(topic.description).toBeNull();
    expect(topic.entries).toEqual([]);
  });

  it("indexes content directly under a date heading as a timestamp-less entry", () => {
    const topic = parseOk("# T\n\n## 2026-01-01\n\nloose external note\n\n### 10:00\n\ntimed\n");
    expect(topic.entries).toEqual([
      { date: "2026-01-01", time: null, content: "loose external note", wikilinks: [], underDuplicateHeading: false },
      { date: "2026-01-01", time: "10:00", content: "timed", wikilinks: [], underDuplicateHeading: false },
    ]);
  });

  it("extracts wikilinks per entry, deduped", () => {
    const topic = parseOk(
      "# T\n\n## 2026-01-01\n\n### 10:00\n\nsee [[Foo]] and [[Bar Baz]] and [[Foo]] again\n\n### 09:00\n\nno links here\n",
    );
    expect(topic.entries[0]!.wikilinks).toEqual(["Foo", "Bar Baz"]);
    expect(topic.entries[1]!.wikilinks).toEqual([]);
  });

  it("ignores headings and wikilinks inside fenced code blocks", () => {
    const topic = parseOk(
      "# T\n\n## 2026-01-01\n\n### 10:00\n\nbefore\n\n```bash\n## not a heading\n### 99:99 not a timestamp\necho \"[[Not A Link]]\"\n```\n\nafter [[Real Link]]\n",
    );
    expect(topic.entries).toHaveLength(1);
    const entry = topic.entries[0]!;
    expect(entry.content).toContain("## not a heading");
    expect(entry.content).toContain("[[Not A Link]]");
    expect(entry.wikilinks).toEqual(["Real Link"]);
  });

  it("allows H4+ headings and wikilinks in the description as plain content", () => {
    const topic = parseOk("# T\n\n#### sub\nsee [[Linked]]\n\n## 2026-01-01\n\n### 10:00\n\nx\n");
    expect(topic.description).toBe("#### sub\nsee [[Linked]]");
  });

  it("merges duplicate date headings and flags all their entries read-only", () => {
    const topic = parseOk(
      "# T\n\n## 2026-05-01\n\n### 10:00\n\nfirst\n\n## 2026-04-30\n\n### 08:00\n\nother\n\n## 2026-05-01\n\n### 09:00\n\nsecond\n",
    );
    const may1 = topic.entries.filter((e) => e.date === "2026-05-01");
    expect(may1).toHaveLength(2);
    expect(may1.every((e) => e.underDuplicateHeading)).toBe(true);
    const apr30 = topic.entries.find((e) => e.date === "2026-04-30")!;
    expect(apr30.underDuplicateHeading).toBe(false);
  });

  it("merges duplicate timestamps into one entry, content concatenated", () => {
    const topic = parseOk("# T\n\n## 2026-05-02\n\n### 10:00\n\npart one\n\n### 10:00\n\npart two\n");
    expect(topic.entries).toHaveLength(1);
    const entry = topic.entries[0]!;
    expect(entry.content).toBe("part one\n\npart two");
    expect(entry.underDuplicateHeading).toBe(true);
  });

  it("rejects a file whose first line is not `# Title`", () => {
    const result = parseTopicFile("not a title\n\n## 2026-01-01\n");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("# <Topic Title>") });
  });

  it("rejects an empty file", () => {
    expect(parseTopicFile("").ok).toBe(false);
  });

  it("rejects a non-date H2 heading", () => {
    const result = parseTopicFile("# T\n\n## Ideas\n\ncontent\n");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("## Ideas") });
  });

  it("rejects an invalid calendar date", () => {
    expect(parseTopicFile("# T\n\n## 2026-13-45\n\nx\n").ok).toBe(false);
    expect(parseTopicFile("# T\n\n## 2026-02-30\n\nx\n").ok).toBe(false);
  });

  it("rejects an invalid timestamp heading", () => {
    expect(parseTopicFile("# T\n\n## 2026-01-01\n\n### 25:99\n\nx\n").ok).toBe(false);
    expect(parseTopicFile("# T\n\n## 2026-01-01\n\n### notes\n\nx\n").ok).toBe(false);
  });

  it("rejects a timestamp heading before any date heading", () => {
    expect(parseTopicFile("# T\n\n### 10:00\n\nx\n").ok).toBe(false);
  });
});
