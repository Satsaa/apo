"use client";

import { useCallback, useMemo, useState } from "react";
import {
  type AutomationActionType,
  type AutomationCondition,
  type AutomationEventType,
  type AutomationSummary,
  createAutomation,
} from "@/lib/automations-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CreateAutomationDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (automation: AutomationSummary, secret: string | null) => void;
  onError: (message: string | null) => void;
}

const EVENT_TYPES: { value: AutomationEventType; label: string }[] = [
  { value: "batch_run.failed", label: "Batch run failed" },
  { value: "batch_run.completed", label: "Batch run completed" },
  { value: "task_run.completed", label: "Task run completed" },
  { value: "task_run.error", label: "Task run errored" },
  { value: "task_run.started", label: "Task run started" },
  { value: "task_run.trace_claimed", label: "Task run trace claimed" },
];

const TASK_RUN_FIELDS = [
  "task_id",
  "status",
  "pass_result",
  "failed_checks",
  "total_checks",
  "trace_run_id",
] as const;
const BATCH_RUN_FIELDS = [
  "status",
  "failed_tasks",
  "total_tasks",
  "errored_tasks",
  "trigger.source",
  "schedule.name",
] as const;

const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"] as const;

function fieldsForEvent(eventType: AutomationEventType): readonly string[] {
  if (eventType === "batch_run.completed" || eventType === "batch_run.failed") {
    return BATCH_RUN_FIELDS;
  }
  if (eventType === "task_run.trace_claimed") {
    return ["task_run_id", "trace_run_id", "batch_run_id", "status"] as const;
  }
  return TASK_RUN_FIELDS;
}

interface ConditionDraft {
  field: string;
  operator: string;
  value: string;
}

function parseConditionValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return raw;
}

export default function CreateAutomationDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
  onError,
}: CreateAutomationDialogProps) {
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState<AutomationEventType>("batch_run.failed");
  const [conditions, setConditions] = useState<ConditionDraft[]>([]);
  const [actionType, setActionType] = useState<AutomationActionType>("webhook");
  const [url, setUrl] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [labels, setLabels] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fields = useMemo(() => fieldsForEvent(eventType), [eventType]);

  const addCondition = useCallback(() => {
    setConditions((prev) => [
      ...prev,
      { field: fields[0], operator: "eq", value: "" },
    ]);
  }, [fields]);

  const updateCondition = useCallback(
    (index: number, patch: Partial<ConditionDraft>) => {
      setConditions((prev) =>
        prev.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
      );
    },
    [],
  );

  const removeCondition = useCallback((index: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const reset = useCallback(() => {
    setName("");
    setEventType("batch_run.failed");
    setConditions([]);
    setActionType("webhook");
    setUrl("");
    setOwner("");
    setRepo("");
    setLabels("");
    setGithubToken("");
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    onError(null);
    const parsedConditions: AutomationCondition[] = conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      value: parseConditionValue(condition.value),
    }));
    try {
      const created = await createAutomation({
        project_id: projectId,
        name: name.trim() || `${eventType} automation`,
        event_type: eventType,
        conditions: parsedConditions,
        action_type: actionType,
        action_config:
          actionType === "webhook"
            ? { url }
            : {
                owner,
                repo,
                labels: labels
                  ? labels.split(",").map((l) => l.trim()).filter(Boolean)
                  : null,
                title: null,
                body: null,
              },
        github_token: actionType === "github_issue" ? githubToken : undefined,
      });
      onCreated(created, created.secret ?? null);
      reset();
      onOpenChange(false);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "Failed to create automation");
    } finally {
      setSubmitting(false);
    }
  }, [
    actionType,
    conditions,
    eventType,
    githubToken,
    labels,
    name,
    onError,
    onCreated,
    onOpenChange,
    owner,
    projectId,
    repo,
    reset,
    url,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Automation</DialogTitle>
          <DialogDescription>
            Deliver a verdict where repair happens when a run event matches.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              className="h-8 text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly failures → GitHub issue"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="automation-event">Event</Label>
            <select
              id="automation-event"
              className="h-8 border border-input bg-background px-2 text-xs"
              value={eventType}
              onChange={(e) => {
                setEventType(e.target.value as AutomationEventType);
                setConditions([]);
              }}
            >
              {EVENT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Conditions</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                onClick={addCondition}
              >
                Add Condition
              </Button>
            </div>
            {conditions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Fires on every event of this type.
              </p>
            ) : (
              conditions.map((condition, index) => (
                <div key={index} className="flex items-center gap-2">
                  <select
                    aria-label={`Condition ${index + 1} field`}
                    className="h-8 border border-input bg-background px-2 text-xs"
                    value={condition.field}
                    onChange={(e) =>
                      updateCondition(index, { field: e.target.value })
                    }
                  >
                    {fields.map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Condition ${index + 1} operator`}
                    className="h-8 border border-input bg-background px-2 text-xs"
                    value={condition.operator}
                    onChange={(e) =>
                      updateCondition(index, { operator: e.target.value })
                    }
                  >
                    {OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label={`Condition ${index + 1} value`}
                    className="h-8 text-xs"
                    value={condition.value}
                    onChange={(e) =>
                      updateCondition(index, { value: e.target.value })
                    }
                    placeholder="false, schedule, 2…"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => removeCondition(index)}
                  >
                    Remove
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="automation-action">Action</Label>
            <select
              id="automation-action"
              className="h-8 border border-input bg-background px-2 text-xs"
              value={actionType}
              onChange={(e) =>
                setActionType(e.target.value as AutomationActionType)
              }
            >
              <option value="webhook">Signed webhook</option>
              <option value="github_issue">GitHub issue</option>
            </select>
          </div>

          {actionType === "webhook" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="automation-url">Webhook URL</Label>
              <Input
                id="automation-url"
                className="h-8 text-xs"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hook"
              />
              <p className="text-xs text-muted-foreground">
                Deliveries are HMAC-signed; the secret is shown once after
                creation.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="automation-owner">Owner</Label>
                  <Input
                    id="automation-owner"
                    className="h-8 text-xs"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="acme"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="automation-repo">Repository</Label>
                  <Input
                    id="automation-repo"
                    className="h-8 text-xs"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    placeholder="agent-harness"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="automation-labels">Labels (comma-separated)</Label>
                <Input
                  id="automation-labels"
                  className="h-8 text-xs"
                  value={labels}
                  onChange={(e) => setLabels(e.target.value)}
                  placeholder="apo, harness-failure"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="automation-token">GitHub token</Label>
                <Input
                  id="automation-token"
                  type="password"
                  className="h-8 text-xs"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_… (needs issues:write)"
                />
                <p className="text-xs text-muted-foreground">
                  Encrypted at rest. The server must have
                  AUTOMATION_TOKEN_ENCRYPTION_KEY configured.
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8"
            onClick={handleSubmit}
            disabled={
              submitting ||
              (actionType === "webhook" && !url.trim()) ||
              (actionType === "github_issue" &&
                (!owner.trim() || !repo.trim() || !githubToken.trim()))
            }
          >
            {submitting ? "Creating…" : "Create Automation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
