import { expect, test } from "@playwright/test";
import { createEntry, login, todayISO } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("create an entry for today via the quick-capture card", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Topic (existing or new)").fill("E2E Alpha");
  await page.getByPlaceholder(/Write markdown/).fill("first e2e entry with a [[E2E Linked]] link");
  await page.getByRole("button", { name: "Save entry" }).click();

  const card = page.locator(".entry-card", {
    has: page.getByRole("link", { name: "E2E Alpha" }),
  });
  await expect(card.getByText("first e2e entry")).toBeVisible();
  // missing wikilink renders as a dashed chip, not a link
  await expect(card.locator(".chip.missing", { hasText: "e2e-linked" })).toBeVisible();
});

test("create an entry for a different (future) date via date navigation", async ({ page }) => {
  await page.goto("/?date=2027-01-15");
  await expect(page.getByRole("heading", { name: "New entry · 2027-01-15" })).toBeVisible();
  await page.getByPlaceholder("Topic (existing or new)").fill("E2E Future");
  await page.getByPlaceholder(/Write markdown/).fill("future-dated entry");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.locator(".entry-card", { hasText: "future-dated entry" })).toBeVisible();

  // the topic view shows the future date first (descending)
  await createEntry(page, "E2E Future", todayISO(), "today entry");
  await page.goto("/topic/e2e-future");
  await expect(page.locator(".date-heading").first()).toHaveText("2027-01-15");
});

test("autocomplete suggests the existing topic while typing", async ({ page }) => {
  await createEntry(page, "E2E Autocomplete", todayISO(), "autocomplete seed");
  await page.goto("/");
  await page.getByPlaceholder("Topic (existing or new)").fill("e2e auto");
  await expect(page.locator(".suggestions button", { hasText: "E2E Autocomplete" })).toBeVisible();
});

test("edit an entry in place from the daily view", async ({ page }) => {
  await createEntry(page, "E2E Edit", todayISO(), "content to edit");
  await page.goto("/");
  const card = page.locator(".entry-card", {
    has: page.getByRole("link", { name: "E2E Edit" }),
  });
  await card.hover();
  await card.getByTitle("Edit").click();
  await card.locator("textarea").fill("rewritten by the e2e suite");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.locator(".md")).toContainText("rewritten by the e2e suite");
});

test("delete an entry; empty date headings disappear from the topic view", async ({ page }) => {
  await createEntry(page, "E2E Delete", "2027-02-20", "entry to delete");
  await page.goto("/?date=2027-02-20");
  const card = page.locator(".entry-card", {
    has: page.getByRole("link", { name: "E2E Delete" }),
  });
  await card.hover();
  page.once("dialog", (d) => d.accept());
  await card.getByTitle("Delete").click();
  await expect(page.getByText("No entries on 2027-02-20.")).toBeVisible();

  await page.goto("/topic/e2e-delete");
  await expect(page.locator(".date-heading")).toHaveCount(0);
  await expect(page.getByText("0 entries · 0 days")).toBeVisible();
});
