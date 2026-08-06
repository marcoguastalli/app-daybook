import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// E2E runs against the production compose stack (docker compose up) and
// authenticates with the real APP_PASSWORD — load it from .env.
try {
  for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
} catch {
  // no .env: rely on the process environment (CI)
}

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1, // single-user app: tests mutate shared topic files
  timeout: 30_000,
  globalTeardown: "./tests/e2e/teardown.ts",
  use: {
    baseURL: `http://localhost:${process.env.APP_PORT ?? "7777"}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
