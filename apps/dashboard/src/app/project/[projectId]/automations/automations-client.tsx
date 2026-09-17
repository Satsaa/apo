"use client";

import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import {
  type AutomationSummary,
  rotateAutomationSecret,
  updateAutomation,
} from "@/lib/automations-api";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import AutomationCard from "./AutomationCard";
import CreateAutomationDialog from "./CreateAutomationDialog";
import EditAutomationDialog from "./EditAutomationDialog";

interface AutomationsClientProps {
  projectId: string;
  initialAutomations: AutomationSummary[];
  error: string | null;
  canManage: boolean;
}

export default function AutomationsClient({
  projectId,
  initialAutomations,
  error,
  canManage,
}: AutomationsClientProps) {
  const [automations, setAutomations] =
    useState<AutomationSummary[]>(initialAutomations);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AutomationSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);

  const patchInList = useCallback((updated: AutomationSummary) => {
    setAutomations((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);

  const handleCreated = useCallback(
    (created: AutomationSummary, secret: string | null) => {
      setAutomations((prev) => [created, ...prev]);
      if (secret) setOneTimeSecret(secret);
    },
    [],
  );

  const handleToggle = useCallback(
    async (automation: AutomationSummary) => {
      setActionError(null);
      try {
        patchInList(await updateAutomation(automation.id, { enabled: !automation.enabled }));
      } catch (e: unknown) {
        setActionError(e instanceof Error ? e.message : "Failed to update automation");
      }
    },
    [patchInList],
  );

  const handleRotate = useCallback(
    async (automation: AutomationSummary) => {
      setActionError(null);
      try {
        const result = await rotateAutomationSecret(automation.id);
        setOneTimeSecret(result.secret);
      } catch (e: unknown) {
        setActionError(e instanceof Error ? e.message : "Failed to rotate secret");
      }
    },
    [],
  );

  const handleDeleted = useCallback((id: string) => {
    setAutomations((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleCreateClick = useCallback(() => {
    setActionError(null);
    setCreateOpen(true);
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Automations</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Deliver run-event verdicts where repair happens — webhooks and GitHub
            issues fired on matching events.
          </p>
        </div>
        {canManage ? (
          <Button type="button" size="sm" className="h-8" onClick={handleCreateClick}>
            <Plus className="size-4" aria-hidden />
            New Automation
          </Button>
        ) : null}
      </header>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}
      {oneTimeSecret ? (
        <div className="border border-border bg-muted/40 px-3 py-2 text-xs">
          <p className="font-medium">Signing secret (shown once)</p>
          <code className="mt-1 block break-all font-mono">{oneTimeSecret}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-7"
            onClick={() => setOneTimeSecret(null)}
          >
            I&apos;ve Saved It
          </Button>
        </div>
      ) : null}

      {automations.length === 0 ? (
        <p className="px-1 py-8 text-center text-xs text-muted-foreground">
          No automations yet. Create one to get notified when runs fail.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {automations.map((automation) => (
            <AutomationCard
              key={automation.id}
              automation={automation}
              manageable={canManage}
              onToggle={handleToggle}
              onRotate={handleRotate}
              onDelete={handleDeleted}
              onEdit={setEditing}
              onError={setActionError}
            />
          ))}
        </div>
      )}

      {canManage && editing ? (
        <EditAutomationDialog
          key={editing.id}
          automation={editing}
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onUpdated={patchInList}
          onError={setActionError}
        />
      ) : null}
      {canManage ? (
        <CreateAutomationDialog
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={handleCreated}
          onError={setActionError}
        />
      ) : null}
    </div>
  );
}
