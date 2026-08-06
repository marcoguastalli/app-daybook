import { Hono } from "hono";
import type { Sql } from "../db/client";
import { isValidDate } from "../core/parser";

export function createDaysRoutes(sql: Sql): Hono {
  const app = new Hono();

  app.get("/:date", async (c) => {
    const date = c.req.param("date");
    if (!isValidDate(date)) return c.json({ error: "invalid date, expected YYYY-MM-DD" }, 400);

    const entries = await sql`
      SELECT t.slug, t.title, to_char(e.entry_time, 'HH24:MI') AS time, e.content,
             coalesce(array_agg(w.target_slug ORDER BY w.id) FILTER (WHERE w.id IS NOT NULL), '{}') AS wikilinks
      FROM entries e
      JOIN topics t ON t.id = e.topic_id
      LEFT JOIN wikilinks w ON w.entry_id = e.id
      WHERE e.entry_date = ${date}
      GROUP BY e.id, t.slug, t.title
      ORDER BY e.entry_time DESC NULLS LAST, t.title
    `;
    return c.json({ date, entries: [...entries] });
  });

  return app;
}
