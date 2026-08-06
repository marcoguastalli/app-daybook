import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { externalEdit, login, reindex, TOPICS_DIR } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("stale-index 409: external edit → save refused → one-click reindex and retry works", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByPlaceholder("Topic (existing or new)").fill("E2E Stale");
  await page.getByPlaceholder(/Write markdown/).fill("app-written content");
  await page.getByRole("button", { name: "Save entry" }).click();
  // stable across edit mode: the topic link stays visible, the content won't
  const card = page.locator(".entry-card", {
    has: page.getByRole("link", { name: "E2E Stale" }),
  });
  await expect(card.getByText("app-written content")).toBeVisible();

  // vim-style external edit behind the app's back
  await externalEdit("e2e-stale.md", "\nexternal vim edit\n");

  await card.hover();
  await card.getByTitle("Edit").click();
  await card.locator("textarea").fill("edited after external change");
  await card.getByRole("button", { name: "Save", exact: true }).click();

  const staleBox = card.locator(".editor-error.stale");
  await expect(staleBox).toBeVisible();
  await expect(staleBox.getByText(/changed on disk/)).toBeVisible();

  await staleBox.getByRole("button", { name: "Reindex and retry" }).click();
  await expect(card.locator(".md")).toContainText("edited after external change");
});

test("duplicate-headings 409: entry is read-only with an explanation, no retry offered", async ({
  page,
}) => {
  await writeFile(
    join(TOPICS_DIR, "e2e-dup.md"),
    "# E2E Dup\n\n## 2026-06-01\n\n### 10:00\n\nfirst block\n\n## 2026-06-01\n\n### 09:00\n\nsecond block\n",
  );
  await reindex(page);

  await page.goto("/topic/e2e-dup");
  // topic-view cards carry stable anchor ids — content text vanishes in edit mode
  const card = page.locator("#e-2026-06-01-1000");
  await expect(card.getByText("first block")).toBeVisible();
  await card.hover();
  await card.getByTitle("Edit").click();
  await card.locator("textarea").fill("this must be refused");
  await card.getByRole("button", { name: "Save", exact: true }).click();

  const dupBox = card.locator(".editor-error.duplicate");
  await expect(dupBox).toBeVisible();
  await expect(dupBox.getByText(/duplicated headings/)).toBeVisible();
  await expect(dupBox.getByText(/retrying will not help/)).toBeVisible();
  await expect(dupBox.getByRole("button", { name: "Reindex and retry" })).toHaveCount(0);
});

test("external file appears after clicking Reindex in the admin view", async ({ page }) => {
  await writeFile(
    join(TOPICS_DIR, "e2e-external.md"),
    "# E2E External\n\nA description written in vim.\n\n## 2026-07-01\n\nloose external note\n",
  );

  await page.goto("/admin");
  await page.getByRole("button", { name: "Reindex now" }).click();
  await expect(page.getByText(/Last full reindex:/)).toBeVisible();

  await page.goto("/topic/e2e-external");
  await expect(page.getByRole("heading", { name: "E2E External" })).toBeVisible();
  await expect(page.getByText("A description written in vim.")).toBeVisible();
  const looseCard = page.locator(".entry-card", { hasText: "loose external note" });
  await expect(looseCard.locator(".entry-time")).toHaveText("—");
});

test("malformed external file is listed in the admin view instead of crashing", async ({
  page,
}) => {
  await writeFile(join(TOPICS_DIR, "e2e-broken.md"), "# E2E Broken\n\n## Ideas\n\nnot a date\n");
  await reindex(page);

  await page.goto("/admin");
  await expect(page.locator(".invalid-list li", { hasText: "e2e-broken.md" })).toBeVisible();
  await expect(page.getByText(/invalid date heading/)).toBeVisible();
});
