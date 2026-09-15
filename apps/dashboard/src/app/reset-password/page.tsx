"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { ErrorBanner } from "@/components/ui/error-banner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PasswordRules } from "@/components/auth/password-rules"
import { ApiError } from "@/lib/api-error"
import { apiClient } from "@/lib/api-client"
import { validatePassword } from "@/lib/password-policy"

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  )
}

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""

  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const checks = validatePassword(newPassword)
  const allChecksPassed = checks.minLength && checks.hasLetter && checks.hasNumber
  const passwordsMatch = newPassword === confirmPassword
  const canSubmit = allChecksPassed && passwordsMatch && token.length > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match")
      return
    }

    setLoading(true)

    try {
      await apiClient("/auth/reset-password", {
        method: "POST",
        body: { token, new_password: newPassword },
      })
      router.push("/login?reset=success")
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || "Failed to reset password")
      } else {
        setError("Unable to connect to server")
      }
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <AuthShell>
        <Link href="/forgot-password">
          <Button type="button" className="h-10 w-full">
            Request a new reset link
          </Button>
        </Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="new-password" className="text-xs text-muted-foreground">
            New password
          </Label>
          <Input
            id="new-password"
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Create a new password"
            autoFocus
          />
          <PasswordRules password={newPassword} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm-password" className="text-xs text-muted-foreground">
            Confirm password
          </Label>
          <Input
            id="confirm-password"
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Repeat the new password"
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
              Resetting...
            </>
          ) : (
            "Reset password"
          )}
        </Button>
      </form>
    </AuthShell>
  )
}
