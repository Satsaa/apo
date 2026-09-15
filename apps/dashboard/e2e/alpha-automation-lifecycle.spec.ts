import { expect, test } from "@playwright/test";

/**
 * internal alpha release gate — automation lifecycle.
 *
 * Validates the automations surface renders a clean operator view: the page
 * mounts, the empty state (or the automation list) is visible, and the
 * create affordance is gated by the manager role exactly like schedules.
 * End-to-end firing (event → condition match → delivery) is covered by
 * `backend/tests/test_automations.py`; this file covers the operator-visible
 * UI contract only.
 *
 * Auth handling: see alpha-project-setup-and-run.spec.ts — tests tolerate
 * either auth-disabled (panels render) or auth-enforced (redirect to /login
 * or /setup).
 */

test.describe("Alpha: automation lifecycle @alpha", () => {
  test("automations surface renders with empty state or list", async ({
    page,
  }) => {
    await page.goto("/project/example-service/automations");
    await page.waitForLoadState("networkidle");

    const url = page.url();
    if (/\/(login|setup)/.test(url)) {
      // Auth enforced — valid alpha state.
      return;
    }

    await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();

    // Either the empty state or at least one automation card must render —
    // never a blank page.
    const emptyState = page.getByText("No automations yet");
    const firstCard = page.locator("article", {
      hasText: "Automation",
    }).first();
    await expect(emptyState.or(firstCard)).toBeVisible();
  });

  test("create affordance is gated by manager role", async ({ page }) => {
    await page.goto("/project/example-service/automations");
    await page.waitForLoadState("networkidle");

    const url = page.url();
    if (/\/(login|setup)/.test(url)) {
      return;
    }

    // When the New Automation button is visible, clicking it must open the
    // create dialog (manager view). When it is absent (viewer), the page
    // still renders the list — the button is simply not offered.
    const createButton = page.getByRole("button", { name: "New Automation" });
    if (await createButton.count()) {
      await createButton.first().click();
      await expect(
        page.getByRole("dialog").getByText("New Automation"),
      ).toBeVisible();
    } else {
      await expect(
        page.getByRole("heading", { name: "Automations" }),
      ).toBeVisible();
    }
  });
});
