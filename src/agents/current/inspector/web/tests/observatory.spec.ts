import { expect, test } from "@playwright/test";

test("empty observatory remains legible", async ({ page }) => {
  await page.route("**/api/runs", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.getByText("MEMORY", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("empty-observatory.png", { fullPage: true });
});
