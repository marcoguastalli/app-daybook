import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "hono";
import { z } from "zod";
import type { Sql } from "../db/client";
import { reindexTopic, sha256 } from "../core/indexer";
import { isValidDate, isValidTime, parseTopicFile, type ParsedEntry } from "../core/parser";
import { slugify } from "../core/slugify";
import {
  addEntry,
  atomicWriteFile,
  createTopicFile,
  deleteEntry,
  editEntry,
} from "../core/writer";
import type { WriteQueue } from "../core/writeQueue";

export interface EntriesDeps {
  sql: Sql;
  topicsDir: string;
  queue: WriteQueue;
  tz: string;
}

class ApiError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

function nowHHMM(tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

interface TopicFileState {
  raw: string;
  exists: boolean;
}

/** Load a topic file for writing, enforcing the stale-index contract:
 *  the file on disk must be exactly what the index last saw.
 *
 *  Reads via node:fs — NOT Bun.file(). A BunFile caches the size from an
 *  earlier stat/exists() and a later .text() returns only that many bytes,
 *  so a file grown by an external editor reads back as its pre-edit content
 *  and the staleness check silently passes (losing the external edit). */
async function loadForWrite(deps: EntriesDeps, slug: string): Promise<TopicFileState> {
  const path = join(deps.topicsDir, `${slug}.md`);
  let raw: string | null = null;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const [row] = await deps.sql`
    SELECT is_valid AS "isValid", file_hash AS "fileHash" FROM topics WHERE slug = ${slug}
  `;

  if (!row && raw === null) return { raw: "", exists: false };
  if (!row || raw === null) {
    throw new ApiError(409, "file changed on disk, reindex first");
  }
  if (!row.isValid) {
    throw new ApiError(409, "topic file is invalid, fix it externally and reindex");
  }
  if (sha256(raw) !== row.fileHash) {
    throw new ApiError(409, "file changed on disk, reindex first");
  }
  return { raw, exists: true };
}

/** Locate an existing entry in the parsed file, enforcing the
 *  duplicate-headings contract (read-only until normalized externally). */
function requireEditableEntry(raw: string, date: string, time: string | null): ParsedEntry {
  const parsed = parseTopicFile(raw);
  if (!parsed.ok) {
    // hash matched an is_valid row, so this should be unreachable
    throw new ApiError(409, "topic file is invalid, fix it externally and reindex");
  }
  const entry = parsed.topic.entries.find((e) => e.date === date && e.time === time);
  if (!entry) throw new ApiError(404, "entry not found");
  if (entry.underDuplicateHeading) {
    throw new ApiError(409, "duplicate headings, normalize externally first");
  }
  return entry;
}

function handleApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
  throw err;
}

const createBody = z.object({
  topicTitle: z.string().trim().min(1),
  date: z.string(),
  content: z.string().trim().min(1),
});

function parseTimeParam(c: Context): { date: string; time: string | null } {
  const date = c.req.param("date")!;
  const rawTime = c.req.param("time")!;
  if (!isValidDate(date)) throw new ApiError(400, "invalid date, expected YYYY-MM-DD");
  if (rawTime !== "-" && !isValidTime(rawTime)) {
    throw new ApiError(400, "invalid time, expected HH:MM or - for timestamp-less");
  }
  return { date, time: rawTime === "-" ? null : rawTime };
}

export function createEntryHandlers(deps: EntriesDeps) {
  const create = async (c: Context) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected { topicTitle, date, content }" }, 400);
    const { topicTitle, date, content } = body.data;
    if (!isValidDate(date)) return c.json({ error: "invalid date, expected YYYY-MM-DD" }, 400);

    let slug: string;
    try {
      slug = slugify(topicTitle);
    } catch {
      return c.json({ error: "topic title produces an empty slug" }, 400);
    }

    try {
      const result = await deps.queue.enqueue(async () => {
        const state = await loadForWrite(deps, slug);
        const time = nowHHMM(deps.tz);
        const base = state.exists ? state.raw : createTopicFile(topicTitle);
        const next = addEntry(base, date, time, content);
        await atomicWriteFile(join(deps.topicsDir, `${slug}.md`), next);
        await reindexTopic(deps.sql, deps.topicsDir, slug);
        return { slug, date, time };
      });
      return c.json(result, 201);
    } catch (err) {
      return handleApiError(c, err);
    }
  };

  const update = async (c: Context) => {
    const slug = c.req.param("slug")!;
    const body = z
      .object({ content: z.string().trim().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected { content }" }, 400);

    try {
      const { date, time } = parseTimeParam(c);
      const result = await deps.queue.enqueue(async () => {
        const state = await loadForWrite(deps, slug);
        if (!state.exists) throw new ApiError(404, "topic not found");
        requireEditableEntry(state.raw, date, time);
        const next = editEntry(state.raw, date, time, body.data.content);
        await atomicWriteFile(join(deps.topicsDir, `${slug}.md`), next);
        await reindexTopic(deps.sql, deps.topicsDir, slug);
        return { slug, date, time };
      });
      return c.json(result);
    } catch (err) {
      return handleApiError(c, err);
    }
  };

  const remove = async (c: Context) => {
    const slug = c.req.param("slug")!;
    try {
      const { date, time } = parseTimeParam(c);
      const result = await deps.queue.enqueue(async () => {
        const state = await loadForWrite(deps, slug);
        if (!state.exists) throw new ApiError(404, "topic not found");
        requireEditableEntry(state.raw, date, time);
        const next = deleteEntry(state.raw, date, time);
        await atomicWriteFile(join(deps.topicsDir, `${slug}.md`), next);
        await reindexTopic(deps.sql, deps.topicsDir, slug);
        return { slug, date, time, deleted: true };
      });
      return c.json(result);
    } catch (err) {
      return handleApiError(c, err);
    }
  };

  return { create, update, remove };
}
