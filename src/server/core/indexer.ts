import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TransactionSql } from "postgres";
import type { Sql } from "../db/client";
import { parseTopicFile } from "./parser";
import { slugify, SLUG_RE } from "./slugify";

export interface InvalidFile {
  slug: string;
  error: string;
}

export interface ReindexResult {
  topicsIndexed: number;
  entriesIndexed: number;
  invalidFiles: InvalidFile[];
  durationMs: number;
  indexedAt: Date;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface IndexFileResult {
  entriesIndexed: number;
  invalid: InvalidFile | null;
}

/** Index one topic file into the given transaction. The topic row for its
 *  slug must not exist yet. Malformed content flags the topic instead of
 *  throwing. */
async function indexFile(
  tx: TransactionSql,
  topicsDir: string,
  file: string,
  indexedAt: Date,
): Promise<IndexFileResult> {
  const slug = basename(file, ".md");
  const filePath = join(topicsDir, file);
  // node:fs, not Bun.file — see loadForWrite in routes/entries.ts: a cached
  // BunFile size can truncate an externally grown file to its old content,
  // which would index (and hash) stale content after an external edit.
  const raw = await readFile(filePath, "utf8");
  const stats = await stat(filePath);
  const fileHash = sha256(raw);

  const flagInvalid = async (error: string): Promise<IndexFileResult> => {
    await tx`
      INSERT INTO topics (slug, title, file_path, file_mtime, file_hash, is_valid, validation_error, indexed_at)
      VALUES (${slug}, ${slug}, ${filePath}, ${stats.mtime}, ${fileHash}, false, ${error}, ${indexedAt})
    `;
    return { entriesIndexed: 0, invalid: { slug, error } };
  };

  if (!SLUG_RE.test(slug)) return flagInvalid(`filename "${file}" is not a valid slug`);

  const parsed = parseTopicFile(raw);
  if (!parsed.ok) return flagInvalid(parsed.error);

  const [topicRow] = await tx<{ id: number }[]>`
    INSERT INTO topics (slug, title, description, file_path, file_mtime, file_hash, is_valid, validation_error, indexed_at)
    VALUES (${slug}, ${parsed.topic.title}, ${parsed.topic.description}, ${filePath}, ${stats.mtime}, ${fileHash}, true, NULL, ${indexedAt})
    RETURNING id
  `;
  const topicId = topicRow!.id;

  let entriesIndexed = 0;
  for (const entry of parsed.topic.entries) {
    const [entryRow] = await tx<{ id: number }[]>`
      INSERT INTO entries (topic_id, entry_date, entry_time, content)
      VALUES (${topicId}, ${entry.date}, ${entry.time}, ${entry.content})
      RETURNING id
    `;
    entriesIndexed++;

    for (const targetTitle of entry.wikilinks) {
      let targetSlug: string;
      try {
        targetSlug = slugify(targetTitle);
      } catch {
        continue; // normalizes to nothing: can never match a real topic
      }
      // Two differently-cased wikilinks in the same entry (e.g. [[Foo]]
      // and [[FOO]]) can collide on the same target_slug.
      await tx`
        INSERT INTO wikilinks (entry_id, source_topic_id, target_slug)
        VALUES (${entryRow!.id}, ${topicId}, ${targetSlug})
        ON CONFLICT (entry_id, target_slug) DO NOTHING
      `;
    }
  }
  return { entriesIndexed, invalid: null };
}

/**
 * Full rescan of topicsDir into the index: rebuilds topics, entries and
 * wikilinks from scratch inside one transaction, so a concurrent reader
 * never sees a half-rebuilt index and a crash mid-scan leaves the previous
 * index intact. Malformed files are flagged is_valid=false with the parse
 * error and never abort the scan — every other file still gets indexed.
 */
export async function reindexAll(sql: Sql, topicsDir: string): Promise<ReindexResult> {
  const start = performance.now();
  const indexedAt = new Date();
  const dirEntries = await readdir(topicsDir, { withFileTypes: true });
  const files = dirEntries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);

  const invalidFiles: InvalidFile[] = [];
  let topicsIndexed = 0;
  let entriesIndexed = 0;

  await sql.begin(async (tx) => {
    await tx`DELETE FROM topics`; // cascades to entries and wikilinks

    for (const file of files) {
      const result = await indexFile(tx, topicsDir, file, indexedAt);
      if (result.invalid) {
        invalidFiles.push(result.invalid);
      } else {
        topicsIndexed++;
        entriesIndexed += result.entriesIndexed;
      }
    }
  });

  return { topicsIndexed, entriesIndexed, invalidFiles, durationMs: performance.now() - start, indexedAt };
}

/** Re-index a single topic file after an app write — same code path as the
 *  full rescan, scoped to one slug inside one transaction. */
export async function reindexTopic(sql: Sql, topicsDir: string, slug: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM topics WHERE slug = ${slug}`;
    await indexFile(tx, topicsDir, `${slug}.md`, new Date());
  });
}
