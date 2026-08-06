import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = process.env.APP_PASSWORD ?? "changeme";

export const TOPICS_DIR = join(import.meta.dirname, "../../data/topics");

/** Fast API login via the browser context's cookie jar (the login form
 *  itself is covered explicitly in auth.spec.ts). */
export async function login(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/login", {
    data: { password: PASSWORD },
  });
  expect(res.ok()).toBe(true);
}

export async function reindex(page: Page): Promise<void> {
  const res = await page.request.post("/api/admin/reindex");
  expect(res.ok()).toBe(true);
}

export function todayISO(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Edit a topic file from outside the app (the "vim on the server" scenario),
 * then wait for the container to observe it.
 *
 * The wait is a macOS Docker Desktop artifact, not app slowness: VirtioFS
 * caches file attributes for ~1s, so a read inside the container issued
 * immediately after a host write can still return the pre-write content —
 * long enough for the stale-index check to compare current-vs-current and
 * pass. Linux bind mounts share the host page cache and are coherent at
 * once, so this delay is purely about making the test deterministic here.
 */
export async function externalEdit(file: string, append: string): Promise<void> {
  // Appends through a separate process inside the container rather than from
  // the host. Both are "external" as far as the app is concerned — the point
  // is that something other than the app changed the file — but this way the
  // write runs as the same user that owns app-created topic files, so the
  // test does not depend on host/container uid alignment (a host append fails
  // with EACCES on Linux CI, where bind mounts pass ownership through).
  execFileSync("docker", ["exec", "-i", "daybook-app", "sh", "-c", `cat >> /data/topics/${file}`], {
    input: append,
  });
  await new Promise((r) => setTimeout(r, 1500));
}

/** Seed an entry through the API so each test owns its own data. */
export async function createEntry(
  page: Page,
  topicTitle: string,
  date: string,
  content: string,
): Promise<void> {
  const res = await page.request.post("/api/entries", {
    data: { topicTitle, date, content },
  });
  expect(res.status()).toBe(201);
}
