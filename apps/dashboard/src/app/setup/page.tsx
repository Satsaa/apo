"use client"

import Link from "next/link"
import { useCallback, useReducer } from "react"
import { signIn } from "next-auth/react"
import { useRouter } from "next/navigation"
import { ArrowRight, Loader2, MailCheck } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { ErrorBanner } from "@/components/ui/error-banner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PasswordRules } from "@/components/auth/password-rules"
import { validatePassword } from "@/lib/password-policy"
import { ApiError } from "@/lib/api-error"
import { apiClient } from "@/lib/api-client"
import { backendFetch } from "@/lib/backend-fetch"

function OtpStep({
  otpCode,
  onOtpCodeChange,
  infoMessage,
  error,
  loading,
  onSubmit,
  onResend,
  onBackToForm,
}: {
  otpCode: string
  onOtpCodeChange: (value: string) => void
  infoMessage: string | null
  error: string | null
  loading: boolean
  onSubmit: (e: React.FormEvent) => void
  onResend: () => void
  onBackToForm: () => void
}) {
  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="space-y-4">
        {infoMessage && (
          <div className="flex items-start gap-2 border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{infoMessage}</span>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="otpCode" className="text-xs text-muted-foreground">
            Verification code
          </Label>
          <Input
            id="otpCode"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            value={otpCode}
            onChange={(e) => onOtpCodeChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="h-12 bg-card text-center text-[18px] tracking-[0.5em]"
            placeholder="000000"
            autoFocus
          />
        </div>

        {error && (
          <ErrorBanner>{error}</ErrorBanner>
        )}

        <Button
          type="submit"
          disabled={loading || otpCode.length !== 6}
          className="group h-10 w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying
            </>
          ) : (
            <>
              Verify and continue
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onResend}
            disabled={loading}
            className="text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            Resend code
          </button>
          <button
            type="button"
            onClick={onBackToForm}
            className="text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80"
          >
            Use different email
          </button>
        </div>
      </form>
    </AuthShell>
  )
}

function CreateAccountForm({
  name,
  onNameChange,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  passwordsMatch,
  error,
  loading,
  canSubmit,
  onSubmit,
}: {
  name: string
  onNameChange: (value: string) => void
  email: string
  onEmailChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  confirmPassword: string
  onConfirmPasswordChange: (value: string) => void
  passwordsMatch: boolean
  error: string | null
  loading: boolean
  canSubmit: boolean
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name" className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            id="name"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            required
            autoComplete="name"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-xs text-muted-foreground">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            required
            autoComplete="email"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="you@example.com"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-xs text-muted-foreground">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            required
            autoComplete="new-password"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Create a password"
          />
          {password.length > 0 && <PasswordRules password={password} />}
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="confirmPassword"
            className="text-xs text-muted-foreground"
          >
            Confirm password
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            required
            autoComplete="new-password"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Repeat the password"
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-xs text-destructive">Passwords do not match</p>
          )}
        </div>

        {error && (
          <ErrorBanner>{error}</ErrorBanner>
        )}

        <Button
          type="submit"
          disabled={loading || !canSubmit}
          className="group h-10 w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating account
            </>
          ) : (
            <>
              Create account
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-foreground underline underline-offset-4 transition-opacity hover:opacity-80"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}

// One state machine for the whole first-user setup flow: the account form
// fields, the OTP step, and the shared submission status travel together.
type SetupState = {
  step: "form" | "otp"
  name: string
  email: string
  password: string
  confirmPassword: string
  otpCode: string
  infoMessage: string | null
  error: string | null
  loading: boolean
}

type SetupField = "name" | "email" | "password" | "confirmPassword" | "otpCode"

type SetupAction =
  | { type: "SET_FIELD"; field: SetupField; value: string }
  | { type: "SUBMIT_START" }
  | { type: "OTP_START" }
  | { type: "VALIDATION_ERROR"; message: string }
  | { type: "FAILURE"; message: string }
  | { type: "DONE" }
  | { type: "OTP_REQUIRED"; infoMessage: string }
  | { type: "RESENT"; infoMessage: string }
  | { type: "BACK_TO_FORM" }

const initialSetupState: SetupState = {
  step: "form",
  name: "",
  email: "",
  password: "",
  confirmPassword: "",
  otpCode: "",
  infoMessage: null,
  error: null,
  loading: false,
}

function setupReducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case "SET_FIELD":
      return { ...state, [action.field]: action.value }
    case "SUBMIT_START":
      return { ...state, loading: true, error: null }
    case "OTP_START":
      return { ...state, loading: true, error: null, infoMessage: null }
    case "VALIDATION_ERROR":
      return { ...state, error: action.message }
    case "FAILURE":
      return { ...state, loading: false, error: action.message }
    case "DONE":
      return { ...state, loading: false }
    case "OTP_REQUIRED":
      return { ...state, step: "otp", loading: false, infoMessage: action.infoMessage }
    case "RESENT":
      return { ...state, loading: false, infoMessage: action.infoMessage, otpCode: "" }
    case "BACK_TO_FORM":
      return { ...state, step: "form", otpCode: "", error: null, infoMessage: null }
  }
}

export default function SetupPage() {
  const router = useRouter()
  const [state, dispatch] = useReducer(setupReducer, initialSetupState)
  const {
    step,
    name,
    email,
    password,
    confirmPassword,
    otpCode,
    infoMessage,
    error,
    loading,
  } = state

  const checks = validatePassword(password)
  const allChecksPassed =
    checks.minLength && checks.hasLetter && checks.hasNumber
  const passwordsMatch = password === confirmPassword
  const canSubmit = allChecksPassed && passwordsMatch && email.length > 0

  const handleNameChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "name", value }),
    [],
  )
  const handleEmailChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "email", value }),
    [],
  )
  const handlePasswordChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "password", value }),
    [],
  )
  const handleConfirmPasswordChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "confirmPassword", value }),
    [],
  )
  const handleOtpCodeChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "otpCode", value }),
    [],
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (password !== confirmPassword) {
      dispatch({ type: "VALIDATION_ERROR", message: "Passwords do not match" })
      return
    }

    dispatch({ type: "SUBMIT_START" })

    try {
      const res = await backendFetch("/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        if (data?.detail) {
          dispatch({ type: "FAILURE", message: data.detail })
        } else {
          // No usable JSON detail — usually means the response wasn't JSON
          // (e.g. a 404 HTML page from a misconfigured proxy, or a 502 from
          // a dead backend). Log the raw status + content type so the cause
          // is visible in the browser console instead of a generic error.
          console.error(
            `[setup] POST /auth/setup returned HTTP ${res.status} ` +
              `with content-type "${res.headers.get("content-type") ?? "unknown"}"`,
          )
          dispatch({
            type: "FAILURE",
            message:
              `Couldn't reach the server (HTTP ${res.status}). ` +
              "Check the browser console for details.",
          })
        }
        return
      }

      const data = await res.json()

      if (data.status === "verification_required") {
        dispatch({
          type: "OTP_REQUIRED",
          infoMessage: `We sent a 6-digit verification code to ${email}. Enter it below to activate your account.`,
        })
        return
      }

      await proceedToSignIn()
    } catch {
      dispatch({ type: "FAILURE", message: "Unable to connect to server" })
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault()
    dispatch({ type: "OTP_START" })

    try {
      await apiClient("/auth/verify-email", {
        method: "POST",
        body: { email, code: otpCode },
      })
      await proceedToSignIn()
    } catch (err) {
      if (err instanceof ApiError) {
        dispatch({ type: "FAILURE", message: err.message || "Invalid or expired code" })
      } else {
        dispatch({ type: "FAILURE", message: "Unable to connect to server" })
      }
    }
  }

  async function handleResend() {
    dispatch({ type: "OTP_START" })

    try {
      const res = await backendFetch("/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After")
        const seconds = retryAfter ? parseInt(retryAfter, 10) : 60
        dispatch({
          type: "FAILURE",
          message: `Please wait ${seconds}s before requesting a new code.`,
        })
        return
      }

      dispatch({
        type: "RESENT",
        infoMessage: `A new verification code has been sent to ${email}.`,
      })
    } catch {
      dispatch({ type: "FAILURE", message: "Unable to connect to server" })
    }
  }

  async function proceedToSignIn() {
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
      redirectTo: "/",
    })
    if (result?.error) {
      dispatch({ type: "FAILURE", message: "Account created but sign-in failed. Please log in." })
      router.push("/login")
      return
    }
    dispatch({ type: "DONE" })
    router.push("/")
  }

  if (step === "otp") {
    return (
      <OtpStep
        otpCode={otpCode}
        onOtpCodeChange={handleOtpCodeChange}
        infoMessage={infoMessage}
        error={error}
        loading={loading}
        onSubmit={handleVerifyOtp}
        onResend={handleResend}
        onBackToForm={() => dispatch({ type: "BACK_TO_FORM" })}
      />
    )
  }

  return (
    <CreateAccountForm
      name={name}
      onNameChange={handleNameChange}
      email={email}
      onEmailChange={handleEmailChange}
      password={password}
      onPasswordChange={handlePasswordChange}
      confirmPassword={confirmPassword}
      onConfirmPasswordChange={handleConfirmPasswordChange}
      passwordsMatch={passwordsMatch}
      error={error}
      loading={loading}
      canSubmit={canSubmit}
      onSubmit={handleSubmit}
    />
  )
}
