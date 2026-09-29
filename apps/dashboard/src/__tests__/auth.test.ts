import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { NextAuthConfig, User, Account } from "next-auth";
import type { OIDCConfig } from "next-auth/providers";

const verifiedUser = {
  id: "apo-user",
  email: "verified@example.test",
  name: "Verified",
  is_admin: true,
} satisfies User;
const oidcAccount = {
  provider: "oidc",
  type: "oidc",
  providerAccountId: verifiedUser.id,
} satisfies Account;

async function importAuthAndCaptureConfig(): Promise<NextAuthConfig> {
  let capturedConfig: NextAuthConfig | null = null;

  vi.doMock("next-auth", () => ({
    default: (config: NextAuthConfig) => {
      capturedConfig = config;
      return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
    },
  }));

  vi.doMock("next-auth/providers/credentials", () => ({
    default: (opts: Record<string, unknown>) => opts,
  }));

  vi.doMock("@/lib/config", () => ({
    getBackendBaseUrl: () => "http://localhost:8000",
  }));
  vi.doMock("@/lib/config.server", () => ({
    getServerBackendBaseUrl: () => "http://backend:8000",
  }));

  await import("@/auth");
  if (!capturedConfig) throw new Error("NextAuth configuration was not captured");
  return capturedConfig;
}

const OIDC_ENV = ["AUTH_OIDC_ISSUER", "AUTH_OIDC_CLIENT_ID", "AUTH_OIDC_CLIENT_SECRET"] as const;

function findOidc(config: NextAuthConfig) {
  return config.providers.find(
    (p): p is OIDCConfig<Record<string, unknown>> => typeof p !== "function" && p.type === "oidc",
  );
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected configured auth callback or provider");
  return value;
}

describe("auth.ts single sign-on provider", () => {
  const saved: Partial<Record<(typeof OIDC_ENV)[number], string | undefined>> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const name of OIDC_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of OIDC_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    vi.doUnmock("next-auth");
    vi.doUnmock("next-auth/providers/credentials");
    vi.doUnmock("@/lib/config");
    vi.doUnmock("@/lib/config.server");
    vi.unstubAllGlobals();
  });

  it("registers no SSO provider unless issuer and client id are both set", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test";
    const config = await importAuthAndCaptureConfig();
    expect(findOidc(config)).toBeUndefined();
  });

  it("is a public PKCE client when no secret is configured", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test/";
    process.env.AUTH_OIDC_CLIENT_ID = "apo";
    const config = await importAuthAndCaptureConfig();
    const oidc = required(findOidc(config));
    expect(oidc.issuer).toBe("https://auth.example.test");
    expect(oidc.clientSecret).toBeUndefined();
    expect(oidc.client?.token_endpoint_auth_method).toBe("none");
    expect(oidc.checks).toEqual(expect.arrayContaining(["pkce", "nonce", "state"]));
  });

  it("uses client authentication when a secret is configured", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test";
    process.env.AUTH_OIDC_CLIENT_ID = "apo";
    process.env.AUTH_OIDC_CLIENT_SECRET = "s3cret";
    const oidc = required(findOidc(await importAuthAndCaptureConfig()));
    expect(oidc.clientSecret).toBe("s3cret");
    expect(oidc.client).toBeUndefined();
  });

  it("takes identity from the backend exchange, never from the provider's claims", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test";
    process.env.AUTH_OIDC_CLIENT_ID = "apo";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "u-1",
        email: "verified@example.test",
        name: "Verified",
        is_admin: true,
        expires_at: 1234,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const oidc = required(findOidc(await importAuthAndCaptureConfig()));

    const user = await required(oidc.profile)(
      { sub: "x", email: "claimed@example.test", name: "Claimed", roles: ["agentio_super_admin"] },
      { id_token: "id.t", access_token: "at" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend:8000/auth/oidc/exchange",
      expect.objectContaining({ method: "POST" }),
    );
    expect(user).toMatchObject({
      id: "u-1",
      email: "verified@example.test",
      is_admin: true,
      auth_provider: "oidc",
      sso_expires_at: 1234,
    });
  });

  it("turns a refused exchange into a login redirect instead of a session", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test";
    process.env.AUTH_OIDC_CLIENT_ID = "apo";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }),
    );
    const config = await importAuthAndCaptureConfig();
    const oidc = required(findOidc(config));

    const user = await required(oidc.profile)({ sub: "x" }, { id_token: "id.t", access_token: "at" });
    expect(user.sso_error).toBe("forbidden");
    await expect(
      required(config.callbacks?.signIn)({ user, account: oidcAccount }),
    ).resolves.toBe("/login?sso_error=forbidden");
  });

  it("never lets an SSO user without an apo id through, whatever the exchange said", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test";
    process.env.AUTH_OIDC_CLIENT_ID = "apo";
    const config = await importAuthAndCaptureConfig();
    await expect(
      required(config.callbacks?.signIn)({ user: { ...verifiedUser, id: "authjs-generated-id" }, account: { ...oidcAccount, providerAccountId: "" } }),
    ).resolves.toBe("/login?sso_error=failed");
    await expect(
      required(config.callbacks?.signIn)({ user: verifiedUser, account: { provider: "credentials", type: "credentials", providerAccountId: verifiedUser.id } }),
    ).resolves.toBe(true);
  });

  it("preserves the verified apo identity when Auth.js replaces the OAuth user id", async () => {
    const config = await importAuthAndCaptureConfig();
    const jwt = required(config.callbacks?.jwt);
    // Auth.js getUserAndAccount replaces profile.id; defaultToken.sub uses
    // that replacement. The backend exchange id survives in providerAccountId.
    const user = { ...verifiedUser, id: "authjs-generated-id", sso_expires_at: 1234 };
    const token = required(await jwt({
      token: { ...user, sub: user.id },
      user,
      account: { ...oidcAccount, access_token: "access-token", id_token: "id-token" },
      trigger: "signIn",
    }) ?? undefined);
    expect(token.sub, "Backend lookup must use the verified apo database id").toBe(verifiedUser.id);
    expect(token.id, "Dashboard and backend must agree on the signed-in identity").toBe(verifiedUser.id);
    expect(token.oidc_access_token).toBe("access-token");
    expect(token.oidc_expires_at).toBe(user.sso_expires_at);

    // On session refresh Auth.js supplies neither user nor account.
    const refresh = { token } as Parameters<typeof jwt>[0];
    expect(await jwt(refresh), "Refreshing the cookie must retain the apo identity").toEqual(token);
  });

  it("keeps credential sign-ins on their backend-issued user id", async () => {
    const config = await importAuthAndCaptureConfig();
    const jwt = required(config.callbacks?.jwt);
    const token = await jwt({
      token: { ...verifiedUser, sub: verifiedUser.id },
      user: verifiedUser,
      account: { provider: "credentials", type: "credentials", providerAccountId: "unused" },
      trigger: "signIn",
    });
    expect(token?.sub).toBe(verifiedUser.id);
    expect(token?.id).toBe(verifiedUser.id);
    expect(token?.auth_provider).toBeUndefined();
  });

});

describe("auth.ts cookie configuration", () => {
  let originalNextAuthUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    originalNextAuthUrl = process.env.NEXTAUTH_URL;
  });

  afterEach(() => {
    if (originalNextAuthUrl === undefined) {
      delete process.env.NEXTAUTH_URL;
    } else {
      process.env.NEXTAUTH_URL = originalNextAuthUrl;
    }
    vi.doUnmock("next-auth");
    vi.doUnmock("next-auth/providers/credentials");
    vi.doUnmock("@/lib/config");
  });

  it("uses __Secure- prefixed cookie with secure=true when NEXTAUTH_URL is https", async () => {
    process.env.NEXTAUTH_URL = "https://optimizer.example.com";
    const config = await importAuthAndCaptureConfig();

    const cookie = required(config.cookies?.sessionToken);
    expect(cookie.name).toBe("__Secure-authjs.session-token");
    expect(required(cookie.options).secure).toBe(true);
    expect(required(cookie.options).httpOnly).toBe(true);
    expect(required(cookie.options).sameSite).toBe("lax");
    expect(required(cookie.options).path).toBe("/");
  });

  it("uses plain cookie name with secure=false when NEXTAUTH_URL is http", async () => {
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    const config = await importAuthAndCaptureConfig();

    const cookie = required(config.cookies?.sessionToken);
    expect(cookie.name).toBe("authjs.session-token");
    expect(required(cookie.options).secure).toBe(false);
    expect(required(cookie.options).httpOnly).toBe(true);
    expect(required(cookie.options).sameSite).toBe("lax");
  });

  it("defaults to http mode (plain cookie, secure=false) when NEXTAUTH_URL is unset", async () => {
    delete process.env.NEXTAUTH_URL;
    const config = await importAuthAndCaptureConfig();

    const cookie = required(config.cookies?.sessionToken);
    expect(cookie.name).toBe("authjs.session-token");
    expect(required(cookie.options).secure).toBe(false);
  });
});
