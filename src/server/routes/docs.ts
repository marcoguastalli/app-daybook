import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";

const entryKeyParams = [
  { name: "slug", in: "path", required: true, schema: { type: "string" } },
  { name: "date", in: "path", required: true, schema: { type: "string", example: "2026-08-06" } },
  {
    name: "time",
    in: "path",
    required: true,
    schema: { type: "string", example: "14:30" },
    description: "HH:MM, or the literal `-` for timestamp-less entries",
  },
];

const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
});

export const openApiDoc = {
  openapi: "3.0.3",
  info: {
    title: "app-daybook API",
    version: "1.0.0",
    description:
      "Topic-centric note-taking. Session-cookie auth: POST /api/auth/login first; " +
      "every route except /health and login requires the session cookie. " +
      "Entries are addressed by natural key (slug, date, time) — stable across reindexes.",
  },
  paths: {
    "/health": {
      get: {
        tags: ["admin"],
        summary: "App + DB health (unauthenticated, used by Docker healthcheck)",
        responses: { "200": { description: "ok" }, "503": { description: "db down" } },
      },
    },
    "/api/auth/login": {
      post: {
        tags: ["auth"],
        summary: "Login with the single app password; sets the session cookie",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["password"],
                properties: { password: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "session cookie set" }, "401": err("invalid password") },
      },
    },
    "/api/auth/logout": {
      post: {
        tags: ["auth"],
        summary: "Clear the session cookie (stateless sessions: client-side only)",
        responses: { "200": { description: "cookie cleared" } },
      },
    },
    "/api/topics": {
      get: {
        tags: ["topics"],
        summary: "List topics with entry count, last entry date and validity flag",
        responses: { "200": { description: "topic list" } },
      },
    },
    "/api/topics/{slug}": {
      get: {
        tags: ["topics"],
        summary: "Full topic: description, entries (descending, timestamp-less last per date), entry-precise backlinks",
        parameters: [entryKeyParams[0]],
        responses: { "200": { description: "topic" }, "404": err("topic not found") },
      },
    },
    "/api/entries": {
      post: {
        tags: ["entries"],
        summary: "Create an entry; creates the topic file if missing; timestamp assigned server-side",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["topicTitle", "date", "content"],
                properties: {
                  topicTitle: { type: "string", example: "Bitcoin Node" },
                  date: { type: "string", example: "2026-08-06" },
                  content: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "created: { slug, date, time }" },
          "400": err("validation error"),
          "409": err("file changed on disk, reindex first"),
        },
      },
    },
    "/api/topics/{slug}/entries/{date}/{time}": {
      put: {
        tags: ["entries"],
        summary: "Edit one entry's content",
        parameters: entryKeyParams,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": { description: "updated" },
          "404": err("entry not found"),
          "409": err("stale index (reindex + retry) or duplicate headings (normalize externally)"),
        },
      },
      delete: {
        tags: ["entries"],
        summary: "Delete one entry; empty timestamp/date headings are removed, the topic file never is",
        parameters: entryKeyParams,
        responses: {
          "200": { description: "deleted" },
          "404": err("entry not found"),
          "409": err("stale index (reindex + retry) or duplicate headings (normalize externally)"),
        },
      },
    },
    "/api/days/{date}": {
      get: {
        tags: ["days"],
        summary: "All entries of a date across topics, newest first, timestamp-less last",
        parameters: [entryKeyParams[1]],
        responses: { "200": { description: "day view" }, "400": err("invalid date") },
      },
    },
    "/api/search": {
      get: {
        tags: ["search"],
        summary: "Combined search: fuzzy topic titles (trigram) + full-text content (websearch syntax), ranked with snippets",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "results" }, "400": err("missing q") },
      },
    },
    "/api/autocomplete/topics": {
      get: {
        tags: ["search"],
        summary: "Topic title suggestions for the entry editor (outside /api/topics: 'autocomplete' is a valid slug)",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "suggestions" } },
      },
    },
    "/api/admin/reindex": {
      post: {
        tags: ["admin"],
        summary: "Full rescan of the topics directory; rebuilds the whole index",
        responses: { "200": { description: "reindex stats: counts, invalid files, duration" } },
      },
    },
    "/api/admin/status": {
      get: {
        tags: ["admin"],
        summary: "Admin view data: last reindex stats (in-memory), index counts, invalid files",
        responses: { "200": { description: "status" } },
      },
    },
  },
} as const;

export function createDocsRoutes(): Hono {
  const app = new Hono();
  app.get("/openapi.json", (c) => c.json(openApiDoc));
  app.get("/", swaggerUI({ url: "/docs/openapi.json" }));
  return app;
}
