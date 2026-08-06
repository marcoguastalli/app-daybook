import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("accent-insensitive search from the top bar, highlighted snippet, deep-link to the entry", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByPlaceholder("Topic (existing or new)").fill("E2E Ricette");
  await page.getByPlaceholder(/Write markdown/).fill("Stasera ragù della nonna con tagliatelle");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.locator(".entry-card", { hasText: "tagliatelle" })).toBeVisible();

  // accent-less query typed in the top bar
  await page.getByRole("searchbox").fill("ragu");
  await page.getByRole("searchbox").press("Enter");
  await expect(page).toHaveURL(/\/search\?q=ragu/);

  const hit = page.locator(".search-hit", { hasText: "E2E Ricette" });
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark")).toHaveText("ragù"); // original spelling, highlighted

  // clicking the result opens the topic view scrolled to that entry
  // (highlight via .targeted class — :target never fires on SPA navigation)
  await hit.click();
  await expect(page).toHaveURL(/\/topic\/e2e-ricette#e-/);
  await expect(page.locator(".entry-card.targeted", { hasText: "tagliatelle" })).toBeVisible();
});

test("typo'd topic title still matches via trigram", async ({ page }) => {
  await page.goto("/search?q=ricete");
  await expect(page.locator(".chip", { hasText: "E2E Ricette" })).toBeVisible();
});
