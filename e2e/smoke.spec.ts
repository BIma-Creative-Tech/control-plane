import { expect, test } from "@playwright/test";

// Smoke: `/` tanpa sesi → /login, header CSP ber-nonce ada.
// Di-skip bila PLAYWRIGHT_BASE_URL tidak diset (browser Playwright tidak di-install di image/CI scaffold).
test.skip(!process.env.PLAYWRIGHT_BASE_URL, "PLAYWRIGHT_BASE_URL tidak diset");

test("root redirect ke login + CSP nonce", async ({ page }) => {
  const response = await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  await expect(page.getByRole("button", { name: "Masuk dengan SSO" })).toBeVisible();
});
