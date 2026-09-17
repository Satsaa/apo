import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface CookieConfig {
  sessionToken: {
    name: string;
    options: {
      httpOnly: boolean;
      sameSite: string;
      path: string;
      secure: boolean;
    };
  };
}

interface OidcProviderConfig {
  id: string;
  type: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  checks: string[];
  client?: { token_endpoint_auth_method?: string };
  profile: (
    profile: Record<string, unknown>,
    tokens: { id_token?: string; access_token?: string },
  ) => Promise<Record<string, unknown>>;
}

interface NextAuthConfig {
  cookies: CookieConfig;
  providers: Array<Record<string, unknown> | OidcProviderConfig>;
  callbacks: {
    signIn: (args: {
      user: Record<string, unknown>;
      account: { provider: string } | null;
    }) => Promise<boolean | string>;
  };
  [key: string]: unknown;
}

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
  return capturedConfig!;
}

const OIDC_ENV = ["AUTH_OIDC_ISSUER", "AUTH_OIDC_CLIENT_ID", "AUTH_OIDC_CLIENT_SECRET"] as const;

function findOidc(config: NextAuthConfig): OidcProviderConfig | undefined {
  return config.providers.find((p) => p.id === "oidc") as OidcProviderConfig | undefined;
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
    const oidc = findOidc(config)!;
    expect(oidc.issuer).toBe("https://auth.example.test");
    expect(oidc.clientSecret).toBeUndefined();
    expect(oidc.client?.token_endpoint_auth_method).toBe("none");
    expect(oidc.checks).toEqual(expect.arrayContaining(["pkce", "nonce", "state"]));
  });

  it("uses client authentication when a secret is configured", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test";
    process.env.AUTH_OIDC_CLIENT_ID = "apo";
    process.env.AUTH_OIDC_CLIENT_SECRET = "s3cret";
    const oidc = findOidc(await importAuthAndCaptureConfig())!;
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
    const oidc = findOidc(await importAuthAndCaptureConfig())!;

    const user = await oidc.profile(
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
    const oidc = findOidc(config)!;

    const user = await oidc.profile({ sub: "x" }, { id_token: "id.t", access_token: "at" });
    expect(user.sso_error).toBe("forbidden");
    await expect(
      config.callbacks.signIn({ user, account: { provider: "oidc" } }),
    ).resolves.toBe("/login?sso_error=forbidden");
  });

  it("never lets an SSO user without an apo id through, whatever the exchange said", async () => {
    process.env.AUTH_OIDC_ISSUER = "https://auth.example.test";
    process.env.AUTH_OIDC_CLIENT_ID = "apo";
    const config = await importAuthAndCaptureConfig();
    await expect(
      config.callbacks.signIn({ user: { id: "" }, account: { provider: "oidc" } }),
    ).resolves.toBe("/login?sso_error=failed");
    await expect(
      config.callbacks.signIn({ user: { id: "u-1" }, account: { provider: "credentials" } }),
    ).resolves.toBe(true);
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

    const cookie = config.cookies.sessionToken;
    expect(cookie.name).toBe("__Secure-authjs.session-token");
    expect(cookie.options.secure).toBe(true);
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("lax");
    expect(cookie.options.path).toBe("/");
  });

  it("uses plain cookie name with secure=false when NEXTAUTH_URL is http", async () => {
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    const config = await importAuthAndCaptureConfig();

    const cookie = config.cookies.sessionToken;
    expect(cookie.name).toBe("authjs.session-token");
    expect(cookie.options.secure).toBe(false);
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("lax");
  });

  it("defaults to http mode (plain cookie, secure=false) when NEXTAUTH_URL is unset", async () => {
    delete process.env.NEXTAUTH_URL;
    const config = await importAuthAndCaptureConfig();

    const cookie = config.cookies.sessionToken;
    expect(cookie.name).toBe("authjs.session-token");
    expect(cookie.options.secure).toBe(false);
  });
});
