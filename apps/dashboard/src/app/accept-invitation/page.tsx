"use client"

import { Suspense, useCallback, useEffect, useReducer } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { signIn, useSession } from "next-auth/react"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  LogIn,
  Mail,
} from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { ErrorBanner } from "@/components/ui/error-banner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  acceptInvitationCreateAccount,
  acceptInvitationExistingAccount,
  previewInvitationToken,
  type InvitationTokenPreview,
} from "@/lib/project-invitations-api"
import { PasswordRules } from "@/components/auth/password-rules"
import { validatePassword } from "@/lib/password-policy"

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <AcceptInvitationForm />
    </Suspense>
  )
}

type ViewState =
  | { kind: "loading" }
  | { kind: "invalid"; reason: string | null }
  | { kind: "create-account"; preview: InvitationTokenPreview }
  | { kind: "existing-account"; preview: InvitationTokenPreview }
  | { kind: "accepted"; projectId: string }
  | { kind: "error"; message: string }

// One state machine for the whole flow: the current view plus the
// create-account form fields and submission status that travel with it.
type InvitationState = {
  view: ViewState
  name: string
  password: string
  confirmPassword: string
  submitting: boolean
  formError: string | null
}

type InvitationAction =
  | { type: "PREVIEW_LOADING" }
  | { type: "PREVIEW_INVALID"; reason: string | null }
  | { type: "PREVIEW_LOADED"; preview: InvitationTokenPreview }
  | { type: "PREVIEW_FAILED" }
  | { type: "SET_FIELD"; field: "name" | "password" | "confirmPassword"; value: string }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_ERROR"; message: string }
  | { type: "ACCEPTED"; projectId: string }

const initialInvitationState: InvitationState = {
  view: { kind: "loading" },
  name: "",
  password: "",
  confirmPassword: "",
  submitting: false,
  formError: null,
}

function invitationReducer(
  state: InvitationState,
  action: InvitationAction,
): InvitationState {
  switch (action.type) {
    case "PREVIEW_LOADING":
      return { ...state, view: { kind: "loading" } }
    case "PREVIEW_INVALID":
      return { ...state, view: { kind: "invalid", reason: action.reason } }
    case "PREVIEW_LOADED":
      return {
        ...state,
        view: {
          kind: action.preview.requires_account_creation
            ? "create-account"
            : "existing-account",
          preview: action.preview,
        },
      }
    case "PREVIEW_FAILED":
      return { ...state, view: { kind: "error", message: "Unable to reach server." } }
    case "SET_FIELD":
      if (action.field === "name") return { ...state, name: action.value }
      if (action.field === "password") return { ...state, password: action.value }
      return { ...state, confirmPassword: action.value }
    case "SUBMIT_START":
      return { ...state, submitting: true, formError: null }
    case "SUBMIT_ERROR":
      return { ...state, submitting: false, formError: action.message }
    case "ACCEPTED":
      return {
        ...state,
        submitting: false,
        view: { kind: "accepted", projectId: action.projectId },
      }
  }
}

function AcceptInvitationForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const { data: session, status: sessionStatus } = useSession()

  const [state, dispatch] = useReducer(invitationReducer, initialInvitationState)
  const { view, name, password, confirmPassword, submitting, formError } = state

  useEffect(() => {
    if (!token) {
      dispatch({ type: "PREVIEW_INVALID", reason: "missing" })
      return
    }
    let cancelled = false
    dispatch({ type: "PREVIEW_LOADING" })
    previewInvitationToken(token)
      .then((preview) => {
        if (cancelled) return
        if (!preview.valid) {
          dispatch({ type: "PREVIEW_INVALID", reason: preview.reason })
          return
        }
        dispatch({ type: "PREVIEW_LOADED", preview })
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({ type: "PREVIEW_FAILED" })
        }
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const checks = validatePassword(password)
  const allChecksPassed = checks.minLength && checks.hasLetter && checks.hasNumber
  const passwordsMatch = password === confirmPassword
  const canSubmitCreate =
    allChecksPassed && passwordsMatch && name.trim().length > 0

  const handleNameChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "name", value }),
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

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault()
    if (view.kind !== "create-account") return
    if (password !== confirmPassword) {
      dispatch({ type: "SUBMIT_ERROR", message: "Passwords do not match" })
      return
    }
    dispatch({ type: "SUBMIT_START" })
    try {
      const result = await acceptInvitationCreateAccount({
        token,
        name: name.trim(),
        password,
      })
      // Auto-sign-in with the credentials just submitted.
      const signInResult = await signIn("credentials", {
        email: view.preview.email ?? "",
        password,
        redirect: false,
        redirectTo: `/project/${result.project_id}`,
      })
      if (signInResult?.error) {
        dispatch({
          type: "SUBMIT_ERROR",
          message: "Account created, but sign-in failed. Please log in.",
        })
        router.push("/login")
        return
      }
      dispatch({ type: "ACCEPTED", projectId: result.project_id })
    } catch (err) {
      dispatch({
        type: "SUBMIT_ERROR",
        message: err instanceof Error ? err.message : "Failed to accept invitation",
      })
    }
  }

  async function handleAcceptExistingAccount() {
    if (view.kind !== "existing-account") return
    dispatch({ type: "SUBMIT_START" })
    try {
      const result = await acceptInvitationExistingAccount(token)
      dispatch({ type: "ACCEPTED", projectId: result.project_id })
    } catch (err) {
      dispatch({
        type: "SUBMIT_ERROR",
        message: err instanceof Error ? err.message : "Failed to accept invitation",
      })
    }
  }

  // -----------------------------------------------------------------------
  // Render branches
  // -----------------------------------------------------------------------

  if (view.kind === "loading") {
    return (
      <AuthShell>
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    )
  }

  if (view.kind === "error") {
    return (
      <AuthShell>
        <ErrorBanner>{view.message}</ErrorBanner>
      </AuthShell>
    )
  }

  if (view.kind === "invalid") {
    const headline =
      view.reason === "expired"
        ? "This invitation has expired"
        : view.reason === "revoked"
          ? "This invitation has been revoked"
          : view.reason === "accepted"
            ? "This invitation has already been used"
            : view.reason === "missing"
              ? "No invitation token provided"
              : "This invitation is no longer valid"
    return (
      <AuthShell>
        <div className="text-center">
          <AlertCircle className="mx-auto mb-3 size-8 text-muted-foreground" />
          <h1 className="text-[18px] font-semibold">{headline}</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Ask a project admin to send you a new invitation link.
          </p>
          <Link href="/login">
            <Button type="button" variant="outline" className="mt-5 h-10 w-full">
              Back to sign in
            </Button>
          </Link>
        </div>
      </AuthShell>
    )
  }

  if (view.kind === "accepted") {
    return (
      <AuthShell>
        <div className="text-center">
          <CheckCircle2 className="mx-auto mb-3 size-8 text-success" />
          <h1 className="text-[18px] font-semibold">You&rsquo;re in!</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Redirecting you to your project…
          </p>
          <Link href={`/project/${view.projectId}`}>
            <Button type="button" className="mt-5 h-10 w-full">
              Go to project
              <ArrowRight className="size-4" />
            </Button>
          </Link>
        </div>
      </AuthShell>
    )
  }

  const { preview } = view

  // Existing-account path: if not signed in, prompt sign-in first.
  if (view.kind === "existing-account") {
    return (
      <ExistingAccountView
        preview={preview}
        token={token}
        sessionStatus={sessionStatus}
        sessionEmail={session?.user?.email}
        formError={formError}
        submitting={submitting}
        onAccept={handleAcceptExistingAccount}
      />
    )
  }

  // Create-account path
  return (
    <CreateAccountForm
      preview={preview}
      name={name}
      onNameChange={handleNameChange}
      password={password}
      onPasswordChange={handlePasswordChange}
      confirmPassword={confirmPassword}
      onConfirmPasswordChange={handleConfirmPasswordChange}
      passwordsMatch={passwordsMatch}
      canSubmitCreate={canSubmitCreate}
      formError={formError}
      submitting={submitting}
      onSubmit={handleCreateAccount}
    />
  )
}

function ExistingAccountView({
  preview,
  token,
  sessionStatus,
  sessionEmail,
  formError,
  submitting,
  onAccept,
}: {
  preview: InvitationTokenPreview
  token: string
  sessionStatus: "loading" | "authenticated" | "unauthenticated"
  sessionEmail: string | null | undefined
  formError: string | null
  submitting: boolean
  onAccept: () => void
}) {
  const signedIn = sessionStatus === "authenticated"
  const emailMatches =
    !!sessionEmail &&
    sessionEmail.toLowerCase() === (preview.email ?? "").toLowerCase()
  return (
    <AuthShell>
      <Header preview={preview} />
      {!signedIn ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            An account already exists for{" "}
            <span className="font-medium text-foreground">{preview.email}</span>.
            Sign in to accept this invitation.
          </p>
          {formError && (
            <ErrorBanner>{formError}</ErrorBanner>
          )}
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(
              `/accept-invitation?token=${token}`,
            )}`}
          >
            <Button type="button" className="h-10 w-full">
              <LogIn className="size-4" />
              Sign in to accept
            </Button>
          </Link>
        </div>
      ) : !emailMatches ? (
        <div className="space-y-3">
          <ErrorBanner>
            You&rsquo;re signed in as <strong>{sessionEmail}</strong>, but
            this invitation is for <strong>{preview.email}</strong>. Sign out and
            back in with the invited email to accept it.
          </ErrorBanner>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            You&rsquo;re signed in as{" "}
            <span className="font-medium text-foreground">{preview.email}</span>.
            Accept to join the project as <strong>{preview.role}</strong>.
          </p>
          {formError && (
            <ErrorBanner>{formError}</ErrorBanner>
          )}
          <Button
            type="button"
            onClick={onAccept}
            disabled={submitting}
            className="h-10 w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Accepting…
              </>
            ) : (
              <>
                Accept invitation
                <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </div>
      )}
    </AuthShell>
  )
}

function CreateAccountForm({
  preview,
  name,
  onNameChange,
  password,
  onPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  passwordsMatch,
  canSubmitCreate,
  formError,
  submitting,
  onSubmit,
}: {
  preview: InvitationTokenPreview
  name: string
  onNameChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  confirmPassword: string
  onConfirmPasswordChange: (value: string) => void
  passwordsMatch: boolean
  canSubmitCreate: boolean
  formError: string | null
  submitting: boolean
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <AuthShell>
      <Header preview={preview} />
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
            value={preview.email ?? ""}
            readOnly
            className="h-10 bg-muted/40 text-muted-foreground"
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
          <Label htmlFor="confirmPassword" className="text-xs text-muted-foreground">
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

        {formError && (
          <ErrorBanner>{formError}</ErrorBanner>
        )}

        <Button
          type="submit"
          disabled={submitting || !canSubmitCreate}
          className="group h-10 w-full"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Creating account
            </>
          ) : (
            <>
              Create account and join
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  )
}

function Header({ preview }: { preview: InvitationTokenPreview }) {
  return (
    <div className="mb-5 text-center">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10">
        <Mail className="size-5 text-primary" />
      </div>
      <h1 className="text-[20px] font-semibold">You&rsquo;re invited</h1>
      {preview.project_name && (
        <p className="mt-1 text-sm text-muted-foreground">
          Join <span className="font-medium text-foreground">{preview.project_name}</span>
          {preview.role && (
            <>
              {" "}as <span className="capitalize">{preview.role}</span>
            </>
          )}
        </p>
      )}
    </div>
  )
}
