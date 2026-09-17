"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { useSession, signOut } from "next-auth/react";
import { ApiError } from "@/lib/api-error";
import { apiClient } from "@/lib/api-client";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// One state machine for the change-password form: the three fields travel
// with the submission status they belong to.
type PasswordFormState = {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
  changing: boolean;
  error: string | null;
  success: boolean;
};

type PasswordFormField = "currentPassword" | "newPassword" | "confirmNewPassword";

type PasswordFormAction =
  | { type: "SET_FIELD"; field: PasswordFormField; value: string }
  | { type: "VALIDATION_ERROR"; message: string }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_ERROR"; message: string }
  | { type: "SUBMIT_SUCCESS" };

const initialPasswordFormState: PasswordFormState = {
  currentPassword: "",
  newPassword: "",
  confirmNewPassword: "",
  changing: false,
  error: null,
  success: false,
};

function passwordFormReducer(
  state: PasswordFormState,
  action: PasswordFormAction,
): PasswordFormState {
  switch (action.type) {
    case "SET_FIELD":
      if (action.field === "currentPassword") return { ...state, currentPassword: action.value };
      if (action.field === "newPassword") return { ...state, newPassword: action.value };
      return { ...state, confirmNewPassword: action.value };
    case "VALIDATION_ERROR":
      return { ...state, error: action.message };
    case "SUBMIT_START":
      return { ...state, changing: true, error: null, success: false };
    case "SUBMIT_ERROR":
      return { ...state, changing: false, error: action.message };
    case "SUBMIT_SUCCESS":
      return {
        currentPassword: "",
        newPassword: "",
        confirmNewPassword: "",
        changing: false,
        error: null,
        success: true,
      };
  }
}

export default function ProfileSettingsPage() {
  const { data: session } = useSession();
  const [form, dispatch] = useReducer(passwordFormReducer, initialPasswordFormState);
  const { currentPassword, newPassword, confirmNewPassword, changing, error, success } = form;
  const signOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (signOutTimer.current) clearTimeout(signOutTimer.current);
    };
  }, [signOutTimer]);

  const handleCurrentPasswordChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "currentPassword", value }),
    [],
  );
  const handleNewPasswordChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "newPassword", value }),
    [],
  );
  const handleConfirmNewPasswordChange = useCallback(
    (value: string) => dispatch({ type: "SET_FIELD", field: "confirmNewPassword", value }),
    [],
  );

  async function handleChangePassword() {
    if (newPassword !== confirmNewPassword) {
      dispatch({ type: "VALIDATION_ERROR", message: "Passwords do not match" });
      return;
    }
    dispatch({ type: "SUBMIT_START" });
    try {
      await apiClient("/backend-proxy/auth/change-password", {
        method: "POST",
        body: {
          current_password: currentPassword,
          new_password: newPassword,
        },
      });
      dispatch({ type: "SUBMIT_SUCCESS" });
      signOutTimer.current = setTimeout(() => signOut({ callbackUrl: "/login" }), 2000);
    } catch (err) {
      if (err instanceof ApiError) {
        dispatch({ type: "SUBMIT_ERROR", message: err.message || "Failed to change password" });
      } else {
        dispatch({ type: "SUBMIT_ERROR", message: "Unable to connect to server" });
      }
    }
  }

  return (
    <>
      <SettingsPageHeader
        title="Profile"
        description="Your account identity and password."
        icon={User}
      />

      <div className="mx-auto max-w-2xl px-6 py-8 space-y-10">
        <section>
          <h2 className="text-sm font-semibold mb-3">Identity</h2>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
            <dt className="text-xs uppercase tracking-wider text-muted-foreground self-center">Name</dt>
            <dd className="text-sm">{session?.user?.name || "\u2014"}</dd>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground self-center">Email</dt>
            <dd className="text-sm">{session?.user?.email || "\u2014"}</dd>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground self-center">Role</dt>
            <dd className="text-sm">
              {session?.user?.is_admin ? (
                <span className="inline-flex items-center gap-1 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                  Admin
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  Member
                </span>
              )}
            </dd>
          </dl>
        </section>

        {session?.user?.auth_provider === "oidc" ? (
          <section>
            <h2 className="text-sm font-semibold mb-1">Password</h2>
            <p className="text-xs text-muted-foreground">
              You sign in through single sign-on, so this account has no apo
              password. Manage your credentials with your identity provider.
            </p>
          </section>
        ) : (
        <section>
          <h2 className="text-sm font-semibold mb-1">Change Password</h2>
          <p className="text-xs text-muted-foreground mb-4">
            You will be signed out after a successful change.
          </p>

          <div className="space-y-3 max-w-sm">
            <div>
              <label htmlFor="current-password" className="text-xs text-muted-foreground mb-1 block">
                Current password
              </label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => handleCurrentPasswordChange(e.target.value)}
                autoComplete="current-password"
                className="h-9"
              />
            </div>
            <div>
              <label htmlFor="new-password" className="text-xs text-muted-foreground mb-1 block">
                New password
              </label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => handleNewPasswordChange(e.target.value)}
                autoComplete="new-password"
                className="h-9"
              />
            </div>
            <div>
              <label htmlFor="confirm-new-password" className="text-xs text-muted-foreground mb-1 block">
                Confirm new password
              </label>
              <Input
                id="confirm-new-password"
                type="password"
                value={confirmNewPassword}
                onChange={(e) => handleConfirmNewPasswordChange(e.target.value)}
                autoComplete="new-password"
                className="h-9"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            {success && (
              <p className="text-xs text-success">Password changed. You will be signed out.</p>
            )}

            <Button
              type="button"
              onClick={handleChangePassword}
              disabled={changing || !currentPassword || !newPassword || !confirmNewPassword}
              size="sm"
            >
              {changing ? "Changing..." : "Change password"}
            </Button>
          </div>
        </section>
        )}
      </div>
    </>
  );
}
