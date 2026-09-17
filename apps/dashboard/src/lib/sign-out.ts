import { signOut } from "next-auth/react"
import type { Session } from "next-auth"
import { backendFetch } from "@/lib/backend-fetch"
import { signOutEverywhere } from "@/lib/users-api"

/**
 * Sign the current user out of apo.
 *
 * A password session clears the Auth.js cookie (and, with `everywhere`,
 * revokes every session server-side first). A single sign-on session always
 * revokes server-side — the backend answers with the issuer's end-session
 * URL, and the browser is sent there so the identity provider's own session
 * ends too; otherwise the next "Sign in with …" would silently log straight
 * back in.
 */
export async function signOutOfApo(
  session: Session | null | undefined,
  { everywhere = false }: { everywhere?: boolean } = {},
): Promise<void> {
  if (session?.user?.auth_provider === "oidc") {
    let endSessionUrl: string | null = null
    const res = await backendFetch("/auth/oidc/logout", { method: "POST" })
    if (res.ok) {
      const body: { end_session_url?: string | null } = await res.json()
      endSessionUrl = body.end_session_url ?? null
    }
    // The cookie is already refused by the backend at this point; clearing
    // it locally must not be skipped because the issuer is unreachable.
    await signOut({ redirect: false })
    window.location.assign(endSessionUrl ?? "/login")
    return
  }

  if (everywhere) {
    await signOutEverywhere()
  }
  await signOut({ redirectTo: "/login" })
}
