import { Hono } from "hono";
import type { Sql } from "../db/client";

export function createHealthRoutes(sql: Sql): Hono {
  const app = new Hono();

  // Unauthenticated by design (Docker healthcheck); returns no sensitive data.
  app.get("/health", async (c) => {
    try {
      await sql`SELECT 1`;
      return c.json({ status: "ok", db: "ok" });
    } catch {
      return c.json({ status: "degraded", db: "down" }, 503);
    }
  });

  return app;
}
