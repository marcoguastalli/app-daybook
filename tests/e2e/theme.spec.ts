import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("dark mode toggle persists across reloads", async ({ page }) => {
  await login(page);
  await page.goto("/");

  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const initial = await theme();
  const other = initial === "dark" ? "light" : "dark";

  await page
    .getByRole("button", { name: initial === "dark" ? "Light mode" : "Dark mode" })
    .click();
  expect(await theme()).toBe(other);

  await page.reload();
  expect(await theme()).toBe(other); // persisted in localStorage

  // toggle back so the suite leaves no trace
  await page
    .getByRole("button", { name: other === "dark" ? "Light mode" : "Dark mode" })
    .click();
  expect(await theme()).toBe(initial);
});
