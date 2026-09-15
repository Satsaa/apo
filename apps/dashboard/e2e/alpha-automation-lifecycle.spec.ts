import { expect, test } from "@playwright/test";

/**
 * internal alpha release gate — automation lifecycle.
 *
 * Validates the automations surface renders a clean operator view: the page
 * mounts, the empty state (or the automation list) is visible, and the
 * create affordance stays hidden from visitors without the manager role.
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
    // never a blank page. Cards are the only <article> on the page and each
    // carries `aria-label="Automation <name>"`.
    const emptyState = page.getByText("No automations yet");
    const firstCard = page
      .locator('article[aria-label^="Automation "]')
      .first();
    await expect(emptyState.or(firstCard)).toBeVisible();
  });

  test("create affordance is hidden from visitors without the manager role", async ({
    page,
  }) => {
    await page.goto("/project/example-service/automations");
    await page.waitForLoadState("networkidle");

    const url = page.url();
    if (/\/(login|setup)/.test(url)) {
      return;
    }

    // The suite browses anonymously: the project permissions lookup yields
    // no manager role, so the create affordance must stay hidden. Asserting
    // the manager side (button + dialog) would need a manager session this
    // harness does not provision.
    await expect(
      page.getByRole("heading", { name: "Automations" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New Automation" }),
    ).toHaveCount(0);
  });
});
