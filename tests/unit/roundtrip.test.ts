import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseTopicFile, type ParsedTopic } from "../../src/server/core/parser";
import { serializeTopic } from "../../src/server/core/writer";

const FIXTURES = join(import.meta.dir, "../../test-fixtures/topics");

/** Structural view: what the index would store (duplicate flags excluded —
 *  serialization normalizes duplicates away by design). */
function structure(topic: ParsedTopic) {
  return {
    title: topic.title,
    description: topic.description,
    entries: [...topic.entries]
      .sort((a, b) =>
        a.date === b.date
          ? (a.time ?? "").localeCompare(b.time ?? "")
          : a.date.localeCompare(b.date),
      )
      .map(({ date, time, content, wikilinks }) => ({ date, time, content, wikilinks })),
  };
}

describe("round-trip property on fixtures", () => {
  it("parse → write → parse yields identical structure for every valid fixture", async () => {
    const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    let valid = 0;
    for (const file of files) {
      const raw = await Bun.file(join(FIXTURES, file)).text();
      const first = parseTopicFile(raw);
      if (!first.ok) {
        expect(file.startsWith("malformed-")).toBe(true);
        expect(first.error.length).toBeGreaterThan(0);
        continue;
      }
      expect(file.startsWith("malformed-")).toBe(false);
      valid++;

      const written = serializeTopic(first.topic);
      const second = parseTopicFile(written);
      if (!second.ok) throw new Error(`${file}: serialized output failed to parse: ${second.error}`);
      expect(structure(second.topic)).toEqual(structure(first.topic));

      // serialization is a fixed point: a second write changes nothing
      expect(serializeTopic(second.topic)).toBe(written);
    }
    expect(valid).toBeGreaterThan(0);
  });
});
