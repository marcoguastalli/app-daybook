import { Hono } from "hono";
import type { Sql } from "../db/client";
import { reindexAll, type ReindexResult } from "../core/indexer";
import type { WriteQueue } from "../core/writeQueue";

export interface AdminState {
  lastReindex: ReindexResult | null;
}

export function createAdminRoutes(sql: Sql, topicsDir: string, queue: WriteQueue): Hono {
  const app = new Hono();
  const state: AdminState = { lastReindex: null };

  app.post("/reindex", async (c) => {
    const result = await queue.enqueue(() => reindexAll(sql, topicsDir));
    state.lastReindex = result;
    return c.json(result);
  });

  // Backing data for the admin view: last reindex stats survive only for
  // the process lifetime (in-memory by design — the DB stores no app state).
  app.get("/status", async (c) => {
    const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM topics) AS topics,
             (SELECT count(*)::int FROM entries) AS entries
    `;
    const invalidFiles = await sql`
      SELECT slug, validation_error AS error FROM topics WHERE NOT is_valid ORDER BY slug
    `;
    return c.json({
      lastReindex: state.lastReindex,
      topics: counts!.topics,
      entries: counts!.entries,
      invalidFiles: [...invalidFiles],
    });
  });

  return app;
}
