import NextAuth from "next-auth"
import type { OIDCConfig } from "next-auth/providers"
import type { Provider } from "next-auth/providers"
import Credentials from "next-auth/providers/credentials"
import type { SsoErrorCode } from "@/types/next-auth"
import { getServerBackendBaseUrl } from "@/lib/config.server"

const isHttps = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").startsWith("https://")
const authSecret =
  process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === "production" ? undefined : "dev-insecure-auth-secret")

/**
 * Single sign-on against any OpenID Connect issuer, switched on by
 * `AUTH_OIDC_ISSUER` + `AUTH_OIDC_CLIENT_ID` (the backend validates the same
 * pair at startup). Without `AUTH_OIDC_CLIENT_SECRET` this is a public PKCE
 * client, which is the right shape for a dashboard that shares its
 * environment with every developer running it.
 *
 * Auth.js only completes the code flow. The tokens then go to the backend's
 * `/auth/oidc/exchange`, which verifies them against the issuer itself and
 * decides whether this person may use apo at all — the dashboard never
 * derives identity or admin status from the provider's claims.
 */
function oidcProvider(): OIDCConfig<Record<string, unknown>> | null {
  const issuer = process.env.AUTH_OIDC_ISSUER?.trim().replace(/\/+$/, "")
  const clientId = process.env.AUTH_OIDC_CLIENT_ID?.trim()
  if (!issuer || !clientId) return null
  const clientSecret = process.env.AUTH_OIDC_CLIENT_SECRET?.trim() || undefined
  return {
    id: "oidc",
    name: process.env.AUTH_OIDC_PROVIDER_NAME?.trim() || "Single sign-on",
    type: "oidc",
    issuer,
    clientId,
    clientSecret,
    checks: ["pkce", "state", "nonce"],
    client: clientSecret ? undefined : { token_endpoint_auth_method: "none" },
    authorization: { params: { scope: "openid email profile" } },
    profile: async (_profile, tokens) => exchangeSsoTokens(tokens),
  }
}

type ExchangedUser = {
  id: string
  email: string
  name: string
  is_admin: boolean
  auth_provider: "oidc"
  sso_expires_at?: number
  sso_error?: SsoErrorCode
}

const ssoRefusal = (code: SsoErrorCode): ExchangedUser => ({
  id: "",
  email: "",
  name: "",
  is_admin: false,
  auth_provider: "oidc",
  sso_error: code,
})

async function exchangeSsoTokens(tokens: {
  id_token?: string
  access_token?: string
}): Promise<ExchangedUser> {
  if (!tokens.id_token || !tokens.access_token) return ssoRefusal("failed")
  try {
    const res = await fetch(`${getServerBackendBaseUrl()}/auth/oidc/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: tokens.id_token, access_token: tokens.access_token }),
    })
    if (res.status === 403) return ssoRefusal("forbidden")
    if (res.status === 409) return ssoRefusal("conflict")
    if (res.status === 502 || res.status === 503) return ssoRefusal("unavailable")
    if (!res.ok) return ssoRefusal("failed")
    const user = await res.json()
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: user.is_admin,
      auth_provider: "oidc",
      sso_expires_at: user.expires_at,
    }
  } catch {
    return ssoRefusal("unavailable")
  }
}

const providers: Provider[] = [
  Credentials({
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    authorize: async (credentials) => {
      const backendUrl = getServerBackendBaseUrl()

      // Dev sign-in: the login page's "Sign in as dev" button
      // sends this marker instead of credentials. The marker carries no
      // authority — the backend's DEV_SIGNIN_ENABLED / profile gate is the
      // only thing that grants a session.
      const password = String(credentials?.password ?? "")
      if (password === "__dev_signin__") {
        try {
          const res = await fetch(`${backendUrl}/auth/dev-signin`, {
            method: "POST",
          })
          if (!res.ok) return null
          const user = await res.json()
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            is_admin: user.is_admin,
          }
        } catch {
          return null
        }
      }

      // The backend refuses this with 403 when password sign-in is disabled
      // (AUTH_PASSWORD_LOGIN_ENABLED=false); nothing here needs to know.
      try {
        const res = await fetch(`${backendUrl}/auth/verify-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: credentials.email,
            password: credentials.password,
          }),
        })

        if (!res.ok) return null

        const user = await res.json()
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          is_admin: user.is_admin,
        }
      } catch {
        return null
      }
    },
  }),
]
const sso = oidcProvider()
if (sso) providers.push(sso)

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers,
  secret: authSecret,
  session: {
    strategy: "jwt",
    // Keep the minted cookie lifetime aligned with the backend's session
    // age cap (AUTH_SESSION_MAX_AGE_SECONDS, default 14 days) — the backend
    // rejects cookies older than that no matter what exp we minted, so a
    // longer maxAge here would only produce sessions that fail mid-flight.
    // SSO sessions are shorter still: the backend refuses them past
    // `oidc_expires_at` (the provider's token expiry, capped by
    // AUTH_OIDC_SESSION_MAX_AGE_SECONDS) regardless of this cookie.
    maxAge: 60 * 60 * 24 * 14,
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  cookies: {
    sessionToken: {
      name: isHttps ? "__Secure-authjs.session-token" : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isHttps,
      },
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      // A refused SSO exchange never becomes a session; the login page
      // explains the refusal from the code.
      if (account?.provider === "oidc" && (user.sso_error || !user.id)) {
        return `/login?sso_error=${user.sso_error ?? "failed"}`
      }
      return true
    },
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id
        token.email = user.email
        token.name = user.name
        token.is_admin = user.is_admin
      }
      if (account?.provider === "oidc" && user) {
        token.auth_provider = "oidc"
        token.oidc_id_token = account.id_token
        token.oidc_access_token = account.access_token
        token.oidc_expires_at = user.sso_expires_at
      }
      return token
    },
    async session({ session, token }) {
      session.user.id = token.id as string
      session.user.is_admin = token.is_admin as boolean
      if (token.auth_provider === "oidc") session.user.auth_provider = "oidc"
      return session
    },
  },
})
