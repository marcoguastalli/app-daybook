import { Hono } from "hono";
import type { Sql } from "../db/client";
import { SLUG_RE } from "../core/slugify";

export function createTopicsRoutes(sql: Sql): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const rows = await sql`
      SELECT t.slug, t.title, t.is_valid AS "isValid", t.validation_error AS "validationError",
             count(e.id)::int AS "entryCount", max(e.entry_date)::text AS "lastEntryDate"
      FROM topics t
      LEFT JOIN entries e ON e.topic_id = t.id
      GROUP BY t.id
      ORDER BY t.title
    `;
    return c.json([...rows]);
  });

  app.get("/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!SLUG_RE.test(slug)) return c.json({ error: "invalid slug" }, 400);

    const [topic] = await sql`
      SELECT id, slug, title, description, is_valid AS "isValid", validation_error AS "validationError"
      FROM topics WHERE slug = ${slug}
    `;
    if (!topic) return c.json({ error: "topic not found" }, 404);

    const entries = topic.isValid
      ? await sql`
          SELECT e.entry_date::text AS date, to_char(e.entry_time, 'HH24:MI') AS time, e.content,
                 coalesce(array_agg(w.target_slug ORDER BY w.id) FILTER (WHERE w.id IS NOT NULL), '{}') AS wikilinks
          FROM entries e
          LEFT JOIN wikilinks w ON w.entry_id = e.id
          WHERE e.topic_id = ${topic.id}
          GROUP BY e.id
          ORDER BY e.entry_date DESC, e.entry_time DESC NULLS LAST
        `
      : [];

    const backlinks = await sql`
      SELECT st.slug AS "sourceSlug", st.title AS "sourceTitle",
             e.entry_date::text AS date, to_char(e.entry_time, 'HH24:MI') AS time
      FROM wikilinks w
      JOIN topics st ON st.id = w.source_topic_id
      JOIN entries e ON e.id = w.entry_id
      WHERE w.target_slug = ${slug}
      ORDER BY st.title, e.entry_date DESC, e.entry_time DESC NULLS LAST
    `;

    return c.json({
      slug: topic.slug,
      title: topic.title,
      description: topic.description,
      isValid: topic.isValid,
      validationError: topic.validationError,
      entries: [...entries],
      backlinks: [...backlinks],
    });
  });

  return app;
}
