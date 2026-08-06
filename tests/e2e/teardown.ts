import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const TOPICS_DIR = join(import.meta.dirname, "../../data/topics");
const BASE = `http://localhost:${process.env.APP_PORT ?? "7777"}`;

/** Remove every e2e-* topic file the suite created in the real bind-mounted
 *  topics dir, then reindex so the index matches again. */
export default async function globalTeardown(): Promise<void> {
  const files = await readdir(TOPICS_DIR).catch(() => []);
  for (const file of files) {
    if (file.startsWith("e2e-") && file.endsWith(".md")) {
      await rm(join(TOPICS_DIR, file), { force: true });
    }
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_PASSWORD ?? "changeme" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (cookie) {
    await fetch(`${BASE}/api/admin/reindex`, { method: "POST", headers: { cookie } });
  }
}
