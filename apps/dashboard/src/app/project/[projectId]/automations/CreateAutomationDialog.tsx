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

// Outcome-first, one question per step. The plain-language triggers map to
// real event/condition pairs; the full vocabulary stays available behind
// the Advanced disclosure so the default path stays minimal.
const OUTCOMES: {
  id: AutomationActionType;
  title: string;
  blurb: string;
}[] = [
  {
    id: "github_issue",
    title: "Open a GitHub issue",
    blurb: "The failure lands next to the harness code, with trace links.",
  },
  {
    id: "webhook",
    title: "Call a webhook",
    blurb: "A signed POST to any endpoint you own.",
  },
];

type TriggerId = "scheduled" | "any-batch" | "task" | "error";

interface TriggerChoice {
  id: TriggerId;
  label: string;
  hint: string;
}

const TRIGGER_CHOICES: TriggerChoice[] = [
  {
    id: "scheduled",
    label: "A scheduled batch fails",
    hint: "Nightly / weekly suites — not manual runs",
  },
  {
    id: "any-batch",
    label: "Any batch fails",
    hint: "Including manual and CLI runs",
  },
  {
    id: "task",
    label: "A specific task fails",
    hint: "Watch one task while you stabilize it",
  },
  {
    id: "error",
    label: "A run errors out",
    hint: "Infrastructure breakage, not a test failure",
  },
];

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

const SELECT_CLASS = "h-8 border border-input bg-background px-2 text-xs";

interface ConditionDraft {
  field: string;
  operator: string;
  value: string;
}

function fieldsForEvent(eventType: AutomationEventType): readonly string[] {
  if (eventType === "batch_run.completed" || eventType === "batch_run.failed") {
    return BATCH_RUN_FIELDS;
  }
  if (eventType === "task_run.trace_claimed") {
    return ["task_run_id", "trace_run_id", "batch_run_id", "status"] as const;
  }
  return TASK_RUN_FIELDS;
}

function parseConditionValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return raw;
}

function triggerToRule(
  trigger: TriggerId,
  taskFilter: string,
): { event: AutomationEventType; conditions: AutomationCondition[] } {
  switch (trigger) {
    case "scheduled":
      return {
        event: "batch_run.failed",
        conditions: [
          { field: "trigger.source", operator: "eq", value: "schedule" },
        ],
      };
    case "any-batch":
      return { event: "batch_run.failed", conditions: [] };
    case "task":
      return {
        event: "task_run.completed",
        conditions: [
          { field: "pass_result", operator: "eq", value: false },
          { field: "task_id", operator: "eq", value: taskFilter.trim() },
        ],
      };
    case "error":
      return { event: "task_run.error", conditions: [] };
  }
}

export default function CreateAutomationDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
  onError,
}: CreateAutomationDialogProps) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [outcome, setOutcome] = useState<AutomationActionType | null>(null);
  const [trigger, setTrigger] = useState<TriggerId>("scheduled");
  const [taskFilter, setTaskFilter] = useState("");

  // Advanced overrides — when used they replace the plain-language trigger.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedEvent, setAdvancedEvent] = useState<AutomationEventType | "">("");
  const [advancedConditions, setAdvancedConditions] = useState<ConditionDraft[]>([]);

  // GitHub action.
  const [githubToken, setGithubToken] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [repos, setRepos] = useState<string[] | null>(null);
  const [repoSearchError, setRepoSearchError] = useState<string | null>(null);
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");

  // Webhook action.
  const [url, setUrl] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const rule = useMemo(
    () => triggerToRule(trigger, taskFilter),
    [trigger, taskFilter],
  );
  const triggerLabel = TRIGGER_CHOICES.find((t) => t.id === trigger)?.label ?? "";
  const useAdvanced = advancedOpen && advancedEvent !== "";

  const reset = useCallback(() => {
    setStep(0);
    setOutcome(null);
    setTrigger("scheduled");
    setTaskFilter("");
    setAdvancedOpen(false);
    setAdvancedEvent("");
    setAdvancedConditions([]);
    setGithubToken("");
    setRepoSearch("");
    setRepos(null);
    setRepoSearchError(null);
    setRepoOwner("");
    setRepoName("");
    setUrl("");
  }, []);

  const searchRepos = useCallback(async () => {
    setRepoSearchError(null);
    try {
      // GitHub's API allows browser CORS, so the pasted token can list the
      // user's own repositories directly — no server round-trip needed.
      const res = await fetch(
        "https://api.github.com/user/repos?per_page=100&sort=updated",
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      if (!res.ok) {
        setRepos(null);
        setRepoSearchError(
          res.status === 401
            ? "That token was rejected — check it has repo read access."
            : `GitHub returned ${res.status}. You can still enter the repository manually.`,
        );
        return;
      }
      const data: unknown = await res.json();
      if (Array.isArray(data)) {
        setRepos(
          data
            .map((repo) =>
              typeof (repo as { full_name?: unknown }).full_name === "string"
                ? (repo as { full_name: string }).full_name
                : "",
            )
            .filter(Boolean),
        );
      }
    } catch {
      setRepos(null);
      setRepoSearchError(
        "Could not reach GitHub — you can still enter the repository manually.",
      );
    }
  }, [githubToken]);

  const filteredRepos = useMemo(() => {
    if (repos === null) return [];
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos.slice(0, 8);
    return repos.filter((r) => r.toLowerCase().includes(q)).slice(0, 8);
  }, [repos, repoSearch]);

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (outcome === "webhook") return url.trim().length > 0;
    if (outcome === "github_issue") {
      return (
        githubToken.trim().length > 0 &&
        repoOwner.trim().length > 0 &&
        repoName.trim().length > 0
      );
    }
    return false;
  }, [githubToken, outcome, repoName, repoOwner, submitting, url]);

  const handleSubmit = useCallback(async () => {
    if (outcome === null) return;
    setSubmitting(true);
    onError(null);
    try {
      const event = useAdvanced ? advancedEvent : rule.event;
      const conditions: AutomationCondition[] = useAdvanced
        ? advancedConditions.map((condition) => ({
            field: condition.field,
            operator: condition.operator,
            value: parseConditionValue(condition.value),
          }))
        : rule.conditions;
      const created = await createAutomation({
        project_id: projectId,
        name:
          useAdvanced || trigger === "task"
            ? `${EVENT_TYPES.find((e) => e.value === event)?.label ?? event} → ${
                outcome === "github_issue" ? "GitHub issue" : "webhook"
              }`
            : `${triggerLabel} → ${outcome === "github_issue" ? "GitHub issue" : "webhook"}`,
        event_type: event,
        conditions,
        action_type: outcome,
        action_config:
          outcome === "webhook"
            ? { url: url.trim() }
            : {
                owner: repoOwner.trim(),
                repo: repoName.trim(),
                labels: null,
                title: null,
                body: null,
              },
        github_token: outcome === "github_issue" ? githubToken.trim() : undefined,
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
    advancedConditions,
    advancedEvent,
    githubToken,
    onError,
    onCreated,
    onOpenChange,
    outcome,
    projectId,
    repoName,
    repoOwner,
    reset,
    rule,
    trigger,
    triggerLabel,
    url,
    useAdvanced,
  ]);

  const updateCondition = useCallback(
    (index: number, patch: Partial<ConditionDraft>) => {
      setAdvancedConditions((prev) =>
        prev.map((condition, i) =>
          i === index ? { ...condition, ...patch } : condition,
        ),
      );
    },
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 0
              ? "New Automation"
              : step === 1
                ? "When exactly?"
                : outcome === "github_issue"
                  ? "Which repository?"
                  : "Where should we POST?"}
          </DialogTitle>
          <DialogDescription>
            {step === 0
              ? "What should happen when a run fails?"
              : step === 1
                ? "Pick the runs this applies to."
                : outcome === "github_issue"
                  ? "Last step — where the issue lands."
                  : "Last step — the destination."}
          </DialogDescription>
        </DialogHeader>

        {step === 0 ? (
          <div className="flex flex-col gap-3">
            {OUTCOMES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className="border border-border bg-background p-4 text-left transition-colors hover:border-foreground/40"
                onClick={() => {
                  setOutcome(choice.id);
                  setStep(1);
                }}
              >
                <p className="text-sm font-medium">{choice.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {choice.blurb}
                </p>
              </button>
            ))}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-2">
            {TRIGGER_CHOICES.map((choice) => {
              const selected = trigger === choice.id && !useAdvanced;
              return (
                <button
                  key={choice.id}
                  type="button"
                  aria-pressed={selected}
                  className={`border p-3 text-left text-sm transition-colors ${
                    selected
                      ? "border-foreground bg-muted/30"
                      : "border-border bg-background hover:border-foreground/40"
                  }`}
                  onClick={() => {
                    setTrigger(choice.id);
                    setAdvancedOpen(false);
                  }}
                >
                  <span>
                    {choice.label}
                    <span className="block text-xs text-muted-foreground">
                      {choice.hint}
                    </span>
                  </span>
                  {selected ? (
                    <span aria-hidden className="float-right">
                      ●
                    </span>
                  ) : null}
                </button>
              );
            })}

            {trigger === "task" && !useAdvanced ? (
              <label className="mt-1 flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Task id</span>
                <Input
                  aria-label="Task id to watch"
                  className="h-8 text-xs"
                  value={taskFilter}
                  onChange={(e) => setTaskFilter(e.target.value)}
                  placeholder="data-extraction"
                />
              </label>
            ) : null}

            <div className="mt-3 border-t border-border pt-3">
              <button
                type="button"
                className="text-xs text-muted-foreground underline hover:text-foreground"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? "Hide" : "Advanced"} — pick the raw event and
                conditions
              </button>
              {advancedOpen ? (
                <div className="mt-3 flex flex-col gap-2">
                  <select
                    aria-label="Raw event type"
                    className={SELECT_CLASS}
                    value={advancedEvent}
                    onChange={(e) => {
                      setAdvancedEvent(e.target.value as AutomationEventType);
                      setAdvancedConditions([]);
                    }}
                  >
                    <option value="">Choose an event…</option>
                    {EVENT_TYPES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {advancedEvent ? (
                    <div className="flex flex-col gap-2">
                      {advancedConditions.map((condition, index) => (
                        <div
                          key={index}
                          className="flex flex-col gap-1 sm:flex-row sm:items-center"
                        >
                          <select
                            aria-label={`Condition ${index + 1} field`}
                            className={`${SELECT_CLASS} sm:flex-1`}
                            value={condition.field}
                            onChange={(e) =>
                              updateCondition(index, { field: e.target.value })
                            }
                          >
                            {fieldsForEvent(advancedEvent).map((field) => (
                              <option key={field} value={field}>
                                {field}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={`Condition ${index + 1} operator`}
                            className={SELECT_CLASS}
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
                            className="h-8 flex-1 text-xs"
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
                            onClick={() =>
                              setAdvancedConditions((prev) =>
                                prev.filter((_, i) => i !== index),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 self-start"
                        onClick={() =>
                          setAdvancedConditions((prev) => [
                            ...prev,
                            {
                              field: fieldsForEvent(advancedEvent)[0],
                              operator: "eq",
                              value: "",
                            },
                          ])
                        }
                      >
                        Add Condition
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={useAdvanced ? false : trigger === "task" && !taskFilter.trim()}
                onClick={() => setStep(2)}
              >
                Next
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setStep(0)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 && outcome === "github_issue" ? (
          <div className="flex flex-col gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                GitHub token — encrypted at rest, only needed once
              </span>
              <div className="flex gap-2">
                <Input
                  type="password"
                  aria-label="GitHub token"
                  className="h-8 flex-1 text-xs"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_… (needs issues:write)"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={!githubToken.trim()}
                  onClick={searchRepos}
                >
                  Find My Repositories
                </Button>
              </div>
            </label>

            {repos !== null ? (
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Repository</span>
                <Input
                  aria-label="Filter repositories"
                  className="h-8 text-xs"
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                  placeholder="Filter your repositories…"
                />
                <div className="mt-1 flex max-h-32 flex-col gap-1 overflow-y-auto">
                  {filteredRepos.map((full) => {
                    const [owner, name] = full.split("/");
                    return (
                      <button
                        key={full}
                        type="button"
                        className={`border px-2 py-1.5 text-left font-mono ${
                          repoOwner === owner && repoName === name
                            ? "border-foreground bg-muted/30"
                            : "border-border hover:border-foreground/40"
                        }`}
                        onClick={() => {
                          setRepoOwner(owner);
                          setRepoName(name);
                        }}
                      >
                        {full}
                      </button>
                    );
                  })}
                  {filteredRepos.length === 0 ? (
                    <span className="px-1 text-muted-foreground">
                      No repository matches.
                    </span>
                  ) : null}
                </div>
              </label>
            ) : null}
            {repoSearchError ? (
              <p className="text-muted-foreground">{repoSearchError}</p>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Owner</span>
                <Input
                  aria-label="Repository owner"
                  className="h-8 text-xs"
                  value={repoOwner}
                  onChange={(e) => setRepoOwner(e.target.value)}
                  placeholder="acme"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Repository</span>
                <Input
                  aria-label="Repository name"
                  className="h-8 text-xs"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder="agent-harness"
                />
              </label>
            </div>

            <div className="border border-border bg-muted/20 p-3 font-mono text-xs">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                The issue that will open
              </p>
              <p className="font-medium">
                apo: nightly-batch — 2 of 3 tasks failed
              </p>
              <p className="mt-1 text-muted-foreground">
                | Batch | Trigger | Result | Failing tasks |
              </p>
              <p className="text-muted-foreground">
                data-extraction · summarize-output → traces ↗
              </p>
            </div>

            <div className="mt-1 flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? "Creating…" : "Create Automation"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setStep(1)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 && outcome === "webhook" ? (
          <div className="flex flex-col gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Webhook URL</span>
              <Input
                aria-label="Webhook URL"
                className="h-8 text-xs"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
              />
              <span className="text-muted-foreground">
                Deliveries are HMAC-signed; the secret is shown once after
                creating. Test it right after from the rule&apos;s Test button.
              </span>
            </label>
            <div className="mt-1 flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? "Creating…" : "Create Automation"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setStep(1)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
