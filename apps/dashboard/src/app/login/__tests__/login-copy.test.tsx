/**
 * Admission is invitation-only once initialized. The login page
 * links to /setup only while first-user setup is actually available, and
 * says invitation-only otherwise. No permanent "Create account" link.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
  useSession: vi.fn().mockReturnValue({
    data: undefined,
    status: "unauthenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
  useSearchParams: vi.fn().mockReturnValue({ get: () => null }),
}));

import { LoginPage, describeSsoError } from "../login-form";

describe("login page admission copy", () => {
  it("links to first-user setup while setup is available", () => {
    render(<LoginPage hasUsers={false} setupAvailable={true} devSignin={{ enabled: false, landingPath: "/" }} />);

    expect(screen.getByText(/set up the first admin account/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /set up the first account/i })).toBeDefined();
    expect(
      screen.queryByText(/invitation-only/i),
    ).toBeNull();
  });

  it("says invitation-only once initialized and hides /setup", () => {
    render(<LoginPage hasUsers={true} setupAvailable={false} devSignin={{ enabled: false, landingPath: "/" }} />);

    expect(
      screen.getByText(/accounts on this apo installation are invitation-only/i),
    ).toBeDefined();
    const setupLinks = screen
      .queryAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/setup");
    expect(setupLinks).toEqual([]);
    // The invitation-only wall points uninvited visitors at the docs:
    // how access works and who to ask (alpha policy: admission by request).
    const accessLink = screen.getByRole("link", { name: /how access works/i });
    expect(accessLink.getAttribute("href")).toBe(
      "https://docs.test-apo.online/alpha-policy/",
    );
  });

  it("renders neither copy when the backend is unreachable", () => {
    render(<LoginPage hasUsers={false} setupAvailable={false} devSignin={{ enabled: false, landingPath: "/" }} />);

    expect(screen.queryByText(/invitation-only/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /set up the first account/i })).toBeNull();
  });
});

describe("login page sign-in methods", () => {
  const noDev = { enabled: false, landingPath: "/" };

  it("offers single sign-on beside the password form when both are open", () => {
    render(
      <LoginPage
        hasUsers={true}
        setupAvailable={false}
        devSignin={noDev}
        sso={{ enabled: true, providerName: "Agentio", passwordLoginEnabled: true }}
      />,
    );

    expect(screen.getByRole("button", { name: /sign in with agentio/i })).toBeDefined();
    expect(screen.getByLabelText(/password/i)).toBeDefined();
  });

  it("shows only single sign-on when password sign-in is disabled, even on a fresh install", () => {
    render(
      <LoginPage
        hasUsers={false}
        setupAvailable={true}
        devSignin={noDev}
        sso={{ enabled: true, providerName: "Agentio", passwordLoginEnabled: false }}
      />,
    );

    expect(screen.getByRole("button", { name: /sign in with agentio/i })).toBeDefined();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    // First-user setup is a password path; an SSO-only installation is
    // claimed by its first authorized SSO login instead.
    expect(screen.queryAllByRole("link").filter((a) => a.getAttribute("href") === "/setup")).toEqual([]);
    expect(screen.queryByRole("link", { name: /forgot password/i })).toBeNull();
  });

  it("explains a refused single sign-on from the redirect code", () => {
    expect(describeSsoError("forbidden", "Agentio")).toMatch(/not authorized/i);
    expect(describeSsoError("conflict", "Agentio")).toMatch(/already exists/i);
    expect(describeSsoError("unavailable", null)).toMatch(/not reachable/i);
    expect(describeSsoError("anything-else", null)).toMatch(/failed/i);
    expect(describeSsoError(null, "Agentio")).toBeNull();
  });
});
