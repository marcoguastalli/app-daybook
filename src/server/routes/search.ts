import { Hono } from "hono";
import type { Sql } from "../db/client";

export function createSearchRoutes(sql: Sql): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (q === "") return c.json({ error: "missing query parameter q" }, 400);

    // Fuzzy topic-title matches (trigram, accent-insensitive) shown first.
    const topics = await sql`
      SELECT slug, title
      FROM topics
      WHERE is_valid AND immutable_unaccent(title) % immutable_unaccent(${q})
      ORDER BY similarity(immutable_unaccent(title), immutable_unaccent(${q})) DESC
      LIMIT 20
    `;

    // Full-text content matches: websearch syntax ("exact phrase", -exclude,
    // OR), ranked, with a highlighted snippet. Headline uses daybook_simple
    // (simple + unaccent) so accent-less queries highlight accented words
    // while the snippet keeps the original spelling.
    const entries = await sql`
      SELECT t.slug, t.title, e.entry_date::text AS date, to_char(e.entry_time, 'HH24:MI') AS time,
             ts_headline('daybook_simple', e.content, tsq,
               'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=10') AS snippet
      FROM entries e
      JOIN topics t ON t.id = e.topic_id,
           websearch_to_tsquery('simple', immutable_unaccent(${q})) tsq
      WHERE e.content_tsv @@ tsq
      ORDER BY ts_rank(e.content_tsv, tsq) DESC, e.entry_date DESC
      LIMIT 50
    `;

    return c.json({ query: q, topics: [...topics], entries: [...entries] });
  });

  return app;
}

export function createAutocompleteRoutes(sql: Sql): Hono {
  const app = new Hono();

  // Deliberately outside /api/topics/:slug — "autocomplete" is a valid slug.
  app.get("/topics", async (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (q === "") return c.json({ suggestions: [] });

    const suggestions = await sql`
      SELECT slug, title
      FROM topics
      WHERE is_valid
        AND (immutable_unaccent(title) % immutable_unaccent(${q})
             OR immutable_unaccent(title) ILIKE immutable_unaccent(${q}) || '%')
      ORDER BY similarity(immutable_unaccent(title), immutable_unaccent(${q})) DESC, title
      LIMIT 10
    `;
    return c.json({ suggestions: [...suggestions] });
  });

  return app;
}
