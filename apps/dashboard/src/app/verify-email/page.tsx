"use client"

import { Suspense, useCallback, useEffect, useReducer } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { ErrorBanner } from "@/components/ui/error-banner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError } from "@/lib/api-error"
import { apiClient } from "@/lib/api-client"
import { backendFetch } from "@/lib/backend-fetch"

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailForm />
    </Suspense>
  )
}

// One state machine for the verification flow: the email/code fields travel
// with the submit/resend status and the rate-limit countdown they belong to.
type VerifyState = {
  email: string
  code: string
  error: string | null
  infoMessage: string | null
  loading: boolean
  resending: boolean
  retryAfter: number
  verified: boolean
}

type VerifyAction =
  | { type: "SET_EMAIL"; value: string }
  | { type: "SET_CODE"; value: string }
  | { type: "VERIFY_START" }
  | { type: "VERIFY_FAILED"; message: string }
  | { type: "VERIFIED" }
  | { type: "RESEND_START" }
  | { type: "RESEND_RATE_LIMITED"; seconds: number; message: string }
  | { type: "RESENT"; infoMessage: string }
  | { type: "RESEND_FAILED"; message: string }
  | { type: "TICK" }

const initialVerifyState: VerifyState = {
  email: "",
  code: "",
  error: null,
  infoMessage: null,
  loading: false,
  resending: false,
  retryAfter: 0,
  verified: false,
}

function verifyReducer(state: VerifyState, action: VerifyAction): VerifyState {
  switch (action.type) {
    case "SET_EMAIL":
      return { ...state, email: action.value }
    case "SET_CODE":
      return { ...state, code: action.value }
    case "VERIFY_START":
      return { ...state, loading: true, error: null, infoMessage: null }
    case "VERIFY_FAILED":
      return { ...state, loading: false, error: action.message }
    case "VERIFIED":
      return { ...state, loading: false, verified: true }
    case "RESEND_START":
      return { ...state, resending: true, error: null, infoMessage: null }
    case "RESEND_RATE_LIMITED":
      return {
        ...state,
        resending: false,
        retryAfter: action.seconds,
        error: action.message,
      }
    case "RESENT":
      return {
        ...state,
        resending: false,
        infoMessage: action.infoMessage,
        code: "",
      }
    case "RESEND_FAILED":
      return { ...state, resending: false, error: action.message }
    case "TICK":
      return { ...state, retryAfter: state.retryAfter <= 1 ? 0 : state.retryAfter - 1 }
  }
}

function VerifyEmailForm() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [state, dispatch] = useReducer(verifyReducer, initialVerifyState)
  const { email, code, error, infoMessage, loading, resending, retryAfter, verified } = state

  useEffect(() => {
    const emailParam = searchParams.get("email")
    if (emailParam) {
      dispatch({ type: "SET_EMAIL", value: emailParam })
    }
  }, [searchParams])

  useEffect(() => {
    if (retryAfter <= 0) return
    const timer = setInterval(() => dispatch({ type: "TICK" }), 1000)
    return () => clearInterval(timer)
  }, [retryAfter])

  const handleEmailChange = useCallback(
    (value: string) => dispatch({ type: "SET_EMAIL", value }),
    [],
  )
  const handleCodeChange = useCallback(
    (value: string) => dispatch({ type: "SET_CODE", value }),
    [],
  )

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    dispatch({ type: "VERIFY_START" })

    try {
      await apiClient("/auth/verify-email", {
        method: "POST",
        body: { email, code },
      })
      dispatch({ type: "VERIFIED" })
    } catch (err) {
      if (err instanceof ApiError) {
        dispatch({ type: "VERIFY_FAILED", message: err.message || "Invalid or expired code" })
      } else {
        dispatch({ type: "VERIFY_FAILED", message: "Unable to connect to server" })
      }
    }
  }

  async function handleResend() {
    dispatch({ type: "RESEND_START" })

    try {
      const res = await backendFetch("/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("Retry-After")
        const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60
        dispatch({
          type: "RESEND_RATE_LIMITED",
          seconds,
          message: `Please wait ${seconds}s before requesting a new code.`,
        })
        return
      }

      dispatch({
        type: "RESENT",
        infoMessage:
          "If an account exists and is unverified, a new code has been sent. Check your email.",
      })
    } catch {
      dispatch({ type: "RESEND_FAILED", message: "Unable to connect to server" })
    }
  }

  if (verified) {
    return (
      <AuthShell>
        <div className="space-y-4">
          <div className="flex items-center justify-center py-4">
            <div className="rounded-full bg-success/10 p-3">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
          </div>
          <p className="text-sm text-center text-muted-foreground">
            Your email has been verified. You can now sign in to your account.
          </p>
          <Button
            type="button"
            className="h-10 w-full"
            onClick={() => router.push("/login")}
          >
            Continue to login
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleVerify} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-xs text-muted-foreground">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
            autoFocus={!email}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="code" className="text-xs text-muted-foreground">
            Verification code
          </Label>
          <Input
            id="code"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => handleCodeChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="h-12 bg-card text-center text-[18px] tracking-[0.5em]"
            placeholder="000000"
            autoFocus={!!email}
          />
        </div>

        {infoMessage && (
          <p className="border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {infoMessage}
          </p>
        )}

        {error && (
          <ErrorBanner>
            {error}
            {retryAfter > 0 && (
              <span className="ml-1 tabular-nums">({retryAfter}s remaining)</span>
            )}
          </ErrorBanner>
        )}

        <Button
          type="submit"
          disabled={loading || code.length !== 6 || email.length === 0}
          className="group h-10 w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying
            </>
          ) : (
            <>
              Verify email
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>

        <button
          type="button"
          onClick={handleResend}
          disabled={resending || retryAfter > 0 || email.length === 0}
          className="w-full text-center text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {resending
            ? "Sending..."
            : retryAfter > 0
              ? `Resend available in ${retryAfter}s`
              : "Resend verification code"}
        </button>
      </form>
    </AuthShell>
  )
}
