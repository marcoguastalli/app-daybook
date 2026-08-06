import { expect, test } from "@playwright/test";
import { PASSWORD } from "./helpers";

test("unauthenticated visit redirects to the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByPlaceholder("Password")).toBeVisible();
});

test("wrong password shows an error and stays on login", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Invalid password")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("login via the form lands on the daily view; logout returns to login", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: /New entry ·/ })).toBeVisible();

  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login/);
  // session gone: a protected view redirects back to login
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});
