import { mkdir } from "node:fs/promises";
import { createApp } from "./app";
import { applySchema } from "./db/client";
import { sql } from "./db/appDb";
import { env } from "./env";

await mkdir(env.TOPICS_DIR, { recursive: true });
await applySchema(sql);

const app = createApp({
  sql,
  topicsDir: env.TOPICS_DIR,
  tz: env.TZ,
  appPassword: env.APP_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  sessionTtlHours: env.SESSION_TTL_HOURS,
  secureCookies: env.TLS_ENABLED,
});

Bun.serve({
  port: env.APP_PORT,
  fetch: app.fetch,
  tls: env.TLS_ENABLED
    ? { cert: Bun.file(env.TLS_CERT_PATH!), key: Bun.file(env.TLS_KEY_PATH!) }
    : undefined,
});

console.log(
  `app-daybook listening on ${env.TLS_ENABLED ? "https" : "http"}://0.0.0.0:${env.APP_PORT}`,
);
