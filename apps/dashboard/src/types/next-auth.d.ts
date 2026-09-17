import "next-auth"
import type { DefaultSession } from "next-auth"

/** Set on a User by the SSO provider's `profile()` when the backend refused the login. */
export type SsoErrorCode = "forbidden" | "conflict" | "unavailable" | "failed"

declare module "next-auth" {
  interface User {
    id: string
    email: string
    name: string
    is_admin: boolean
    /** "oidc" for a single sign-on login; absent for password and dev sign-in. */
    auth_provider?: "oidc"
    /** Unix seconds after which the backend refuses the SSO session (from the exchange). */
    sso_expires_at?: number
    /** Why the backend refused the SSO login; `signIn` turns it into a redirect. */
    sso_error?: SsoErrorCode
  }

  interface Session extends DefaultSession {
    user: {
      id: string
      email: string
      name: string
      is_admin: boolean
      auth_provider?: "oidc"
    } & DefaultSession["user"]
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string
    email: string
    name: string
    is_admin: boolean
    auth_provider?: "oidc"
    /** Provider tokens the backend uses to revalidate and to end the issuer session. */
    oidc_id_token?: string
    oidc_access_token?: string
    oidc_expires_at?: number
  }
}
