import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Sql } from "./db/client";
import { WriteQueue } from "./core/writeQueue";
import { loginHandler, logoutHandler, sessionGuard, type AuthConfig } from "./routes/auth";
import { createAdminRoutes } from "./routes/admin";
import { createDaysRoutes } from "./routes/days";
import { createDocsRoutes } from "./routes/docs";
import { createEntryHandlers } from "./routes/entries";
import { createHealthRoutes } from "./routes/health";
import { createAutocompleteRoutes, createSearchRoutes } from "./routes/search";
import { createTopicsRoutes } from "./routes/topics";

export interface AppDeps extends AuthConfig {
  sql: Sql;
  topicsDir: string;
  tz: string;
  /** false in integration tests: no built frontend to serve there */
  serveFrontend?: boolean;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const queue = new WriteQueue();

  // Open endpoints: health (Docker healthcheck) and login. Everything
  // registered after the guards below requires a valid session.
  app.route("/", createHealthRoutes(deps.sql));
  app.post("/api/auth/login", loginHandler(deps));

  app.use("/api/*", sessionGuard(deps));
  app.use("/docs", sessionGuard(deps));
  app.use("/docs/*", sessionGuard(deps));

  app.post("/api/auth/logout", logoutHandler());
  app.route("/docs", createDocsRoutes());

  app.route("/api/topics", createTopicsRoutes(deps.sql));
  app.route("/api/days", createDaysRoutes(deps.sql));
  app.route("/api/search", createSearchRoutes(deps.sql));
  app.route("/api/autocomplete", createAutocompleteRoutes(deps.sql));
  app.route("/api/admin", createAdminRoutes(deps.sql, deps.topicsDir, queue));

  const entries = createEntryHandlers({
    sql: deps.sql,
    topicsDir: deps.topicsDir,
    queue,
    tz: deps.tz,
  });
  app.post("/api/entries", entries.create);
  app.put("/api/topics/:slug/entries/:date/:time", entries.update);
  app.delete("/api/topics/:slug/entries/:date/:time", entries.remove);

  if (deps.serveFrontend !== false) {
    // Built SPA; unknown non-/api paths fall back to index.html so deep
    // links like /topic/<slug> survive a refresh.
    app.use("*", serveStatic({ root: "./dist" }));
    app.get("*", serveStatic({ path: "./dist/index.html" }));
  }

  return app;
}
