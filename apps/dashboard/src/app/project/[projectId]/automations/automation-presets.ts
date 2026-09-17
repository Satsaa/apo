import type {
  AutomationCondition,
  AutomationEventType,
  AutomationSummary,
} from "@/lib/automations-api";

// Shared vocabulary for creating and editing automations: the plain-language
// trigger presets, their mapping to real events/conditions, and the reverse
// mapping that re-hydrates an existing rule into the preset it came from.

export type TriggerId = "scheduled" | "any-batch" | "task" | "error";

export interface TriggerChoice {
  id: TriggerId;
  label: string;
  hint: string;
}

export const TRIGGER_CHOICES: TriggerChoice[] = [
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

export const EVENT_TYPES: { value: AutomationEventType; label: string }[] = [
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

export const OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
] as const;

export const SELECT_CLASS = "h-8 border border-input bg-background px-2 text-xs";

export function fieldsForEvent(eventType: AutomationEventType): readonly string[] {
  if (eventType === "batch_run.completed" || eventType === "batch_run.failed") {
    return BATCH_RUN_FIELDS;
  }
  if (eventType === "task_run.trace_claimed") {
    return ["task_run_id", "trace_run_id", "batch_run_id", "status"] as const;
  }
  return TASK_RUN_FIELDS;
}

export function parseConditionValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return raw;
}

export function stringifyConditionValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function triggerToRule(
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

export interface ConditionDraft {
  field: string;
  operator: string;
  value: string;
}

export type RuleSource =
  | { mode: "preset"; trigger: TriggerId; taskFilter: string }
  | { mode: "advanced"; event: AutomationEventType; conditions: ConditionDraft[] };

/**
 * Re-hydrate an existing rule into the preset it came from, so Edit shows
 * the same plain language Create produced. Rules that don't match a preset
 * (edited via Advanced or the API) open in Advanced mode with their raw
 * event and conditions — never silently reinterpreted.
 */
export function ruleFromAutomation(automation: AutomationSummary): RuleSource {
  const conditions = automation.conditions ?? [];
  const asString = (value: unknown): string =>
    typeof value === "string" ? value : stringifyConditionValue(value);

  const isCond = (
    index: number,
    field: string,
    operator: string,
    value: unknown,
  ): boolean => {
    const condition = conditions[index];
    return (
      !!condition &&
      condition.field === field &&
      condition.operator === operator &&
      asString(condition.value) === stringifyConditionValue(value)
    );
  };

  if (
    automation.event_type === "batch_run.failed" &&
    conditions.length === 1 &&
    typeof conditions[0].value === "string" &&
    isCond(0, "trigger.source", "eq", "schedule")
  ) {
    return { mode: "preset", trigger: "scheduled", taskFilter: "" };
  }
  if (automation.event_type === "batch_run.failed" && conditions.length === 0) {
    return { mode: "preset", trigger: "any-batch", taskFilter: "" };
  }
  if (
    automation.event_type === "task_run.completed" &&
    conditions.length === 2 &&
    // strict types: the backend matches eq with type equality, so the preset
    // only claims rules whose values are the types the preset writes
    typeof conditions.find((c) => c.field === "task_id")?.value === "string" &&
    typeof conditions.find((c) => c.field === "pass_result")?.value ===
      "boolean" &&
    ((isCond(0, "pass_result", "eq", false) &&
      isCond(1, "task_id", "eq", conditions[1].value)) ||
      (isCond(1, "pass_result", "eq", false) &&
        isCond(0, "task_id", "eq", conditions[0].value)))
  ) {
    const taskCondition = conditions.find((c) => c.field === "task_id");
    return {
      mode: "preset",
      trigger: "task",
      taskFilter: typeof taskCondition?.value === "string" ? taskCondition.value : "",
    };
  }
  if (automation.event_type === "task_run.error" && conditions.length === 0) {
    return { mode: "preset", trigger: "error", taskFilter: "" };
  }
  return {
    mode: "advanced",
    event: automation.event_type,
    conditions: conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      value: stringifyConditionValue(condition.value),
    })),
  };
}
