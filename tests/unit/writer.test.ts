import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTopicFile } from "../../src/server/core/parser";
import {
  addEntry,
  atomicWriteFile,
  createTopicFile,
  deleteEntry,
  editEntry,
  EntryNotFoundError,
} from "../../src/server/core/writer";

const FILE =
  "# T\n\n## 2026-08-04\n\n### 18:30\n\nevening\n\n### 09:15\n\nmorning\n\n## 2026-08-01\n\n### 22:00\n\nfirst\n";

function entriesOf(content: string) {
  const result = parseTopicFile(content);
  if (!result.ok) throw new Error(`writer produced unparseable file: ${result.error}`);
  return result.topic.entries.map((e) => `${e.date} ${e.time ?? "-"}: ${e.content}`);
}

describe("createTopicFile", () => {
  it("emits only the title line", () => {
    expect(createTopicFile("Bitcoin Node")).toBe("# Bitcoin Node\n");
  });
});

describe("addEntry", () => {
  it("creates a new date section at the correct descending position", () => {
    const out = addEntry(FILE, "2026-08-02", "12:00", "midday");
    expect(entriesOf(out)).toEqual([
      "2026-08-04 18:30: evening",
      "2026-08-04 09:15: morning",
      "2026-08-02 12:00: midday",
      "2026-08-01 22:00: first",
    ]);
    // physically between the two existing sections
    expect(out.indexOf("## 2026-08-02")).toBeGreaterThan(out.indexOf("## 2026-08-04"));
    expect(out.indexOf("## 2026-08-02")).toBeLessThan(out.indexOf("## 2026-08-01"));
  });

  it("adds a newer date at the top and an older date at the end", () => {
    const newer = addEntry(FILE, "2026-08-05", "08:00", "newest");
    expect(newer.indexOf("## 2026-08-05")).toBeLessThan(newer.indexOf("## 2026-08-04"));
    const older = addEntry(FILE, "2026-07-30", "08:00", "oldest");
    expect(older.indexOf("## 2026-07-30")).toBeGreaterThan(older.indexOf("## 2026-08-01"));
  });

  it("inserts a new timestamp block descending within its date", () => {
    const out = addEntry(FILE, "2026-08-04", "12:00", "noon");
    expect(entriesOf(out)).toEqual([
      "2026-08-04 18:30: evening",
      "2026-08-04 12:00: noon",
      "2026-08-04 09:15: morning",
      "2026-08-01 22:00: first",
    ]);
  });

  it("appends into the existing block on the same minute", () => {
    const out = addEntry(FILE, "2026-08-04", "18:30", "more evening");
    expect(entriesOf(out)[0]).toBe("2026-08-04 18:30: evening\n\nmore evening");
  });

  it("keeps timestamp-less content anchored under its date heading", () => {
    const file = "# T\n\n## 2026-08-01\n\nanchored loose note\n\n### 09:00\n\nnine\n";
    const out = addEntry(file, "2026-08-01", "10:00", "ten");
    // the new ### 10:00 goes after the loose content, before ### 09:00
    const loose = out.indexOf("anchored loose note");
    const ten = out.indexOf("### 10:00");
    const nine = out.indexOf("### 09:00");
    expect(loose).toBeLessThan(ten);
    expect(ten).toBeLessThan(nine);
    expect(entriesOf(out)).toEqual([
      "2026-08-01 -: anchored loose note",
      "2026-08-01 10:00: ten",
      "2026-08-01 09:00: nine",
    ]);
  });

  it("starts from a title-only file", () => {
    const out = addEntry(createTopicFile("T"), "2026-08-04", "10:00", "hello");
    expect(entriesOf(out)).toEqual(["2026-08-04 10:00: hello"]);
  });

  it("does not mistake headings inside code fences for insertion anchors", () => {
    const file = "# T\n\n## 2026-08-04\n\n### 10:00\n\n```\n## 2026-08-02\n### 05:00\n```\n\ntail\n";
    const out = addEntry(file, "2026-08-03", "11:00", "new day");
    expect(entriesOf(out)).toEqual([
      "2026-08-04 10:00: ```\n## 2026-08-02\n### 05:00\n```\n\ntail",
      "2026-08-03 11:00: new day",
    ]);
  });
});

describe("editEntry", () => {
  it("replaces only the target entry content", () => {
    const out = editEntry(FILE, "2026-08-04", "09:15", "rewritten");
    expect(entriesOf(out)).toEqual([
      "2026-08-04 18:30: evening",
      "2026-08-04 09:15: rewritten",
      "2026-08-01 22:00: first",
    ]);
  });

  it("keeps timestamp-less entries timestamp-less", () => {
    const file = "# T\n\n## 2026-08-01\n\nloose note\n\n### 09:00\n\nnine\n";
    const out = editEntry(file, "2026-08-01", null, "edited loose note");
    expect(entriesOf(out)).toEqual([
      "2026-08-01 -: edited loose note",
      "2026-08-01 09:00: nine",
    ]);
    expect(out).not.toContain("### edited");
  });

  it("throws EntryNotFoundError for a missing entry", () => {
    expect(() => editEntry(FILE, "2026-08-04", "11:11", "x")).toThrow(EntryNotFoundError);
    expect(() => editEntry(FILE, "2020-01-01", "10:00", "x")).toThrow(EntryNotFoundError);
    expect(() => editEntry(FILE, "2026-08-04", null, "x")).toThrow(EntryNotFoundError);
  });
});

describe("deleteEntry", () => {
  it("removes the ### heading with the last entry of a timestamp", () => {
    const out = deleteEntry(FILE, "2026-08-04", "09:15");
    expect(out).not.toContain("### 09:15");
    expect(entriesOf(out)).toEqual(["2026-08-04 18:30: evening", "2026-08-01 22:00: first"]);
  });

  it("removes the ## heading with the last entry of a date", () => {
    const out = deleteEntry(FILE, "2026-08-01", "22:00");
    expect(out).not.toContain("## 2026-08-01");
    expect(entriesOf(out)).toEqual(["2026-08-04 18:30: evening", "2026-08-04 09:15: morning"]);
  });

  it("keeps the date heading when a timestamp-less entry remains", () => {
    const file = "# T\n\n## 2026-08-01\n\nloose\n\n### 09:00\n\nnine\n";
    const out = deleteEntry(file, "2026-08-01", "09:00");
    expect(entriesOf(out)).toEqual(["2026-08-01 -: loose"]);
    expect(out).toContain("## 2026-08-01");
  });

  it("deletes a timestamp-less entry and the date heading when nothing remains", () => {
    const file = "# T\n\n## 2026-08-01\n\nonly loose content\n";
    const out = deleteEntry(file, "2026-08-01", null);
    expect(out).toBe("# T\n");
  });

  it("never deletes the topic file content below zero entries: title stays", () => {
    let out = deleteEntry(FILE, "2026-08-04", "18:30");
    out = deleteEntry(out, "2026-08-04", "09:15");
    out = deleteEntry(out, "2026-08-01", "22:00");
    expect(out).toBe("# T\n");
  });

  it("throws EntryNotFoundError for a missing entry", () => {
    expect(() => deleteEntry(FILE, "2026-08-04", "11:11")).toThrow(EntryNotFoundError);
  });
});

describe("atomicWriteFile", () => {
  it("writes the content and leaves no temp files behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daybook-writer-"));
    try {
      const path = join(dir, "topic.md");
      await atomicWriteFile(path, "# T\n");
      await atomicWriteFile(path, "# T\n\n## 2026-01-01\n\n### 10:00\n\nx\n");
      expect(await Bun.file(path).text()).toContain("### 10:00");
      expect(await readdir(dir)).toEqual(["topic.md"]);
      // group-writable so a human can still edit the file by hand on Linux,
      // where the container's ownership passes through the bind mount
      expect((await stat(path)).mode & 0o777).toBe(0o664);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
