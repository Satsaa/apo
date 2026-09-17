import { apiClient } from "./api-client";

// ============================================================================
// Types
// ============================================================================

export type AutomationEventType =
  | "batch_run.completed"
  | "batch_run.failed"
  | "task_run.started"
  | "task_run.completed"
  | "task_run.error"
  | "task_run.trace_claimed";

export type AutomationActionType = "webhook" | "github_issue" | "slack";

export interface AutomationCondition {
  field: string;
  operator: string;
  value: unknown;
}

export interface AutomationSummary {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  event_type: AutomationEventType;
  conditions: AutomationCondition[];
  action_type: AutomationActionType;
  action_config: Record<string, unknown>;
  enabled: boolean;
  consecutive_failures: number;
  last_delivery_at: string | null;
  last_delivery_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationCreateResponse extends AutomationSummary {
  /** Present only for webhook actions: the one-time signing secret. */
  secret?: string | null;
}

export interface AutomationCreateRequest {
  project_id: string;
  name: string;
  description?: string | null;
  event_type: AutomationEventType;
  conditions: AutomationCondition[];
  action_type: AutomationActionType;
  action_config: Record<string, unknown>;
  github_token?: string | null;
}

export interface AutomationExecution {
  id: string;
  event_type: string;
  status: "pending" | "completed" | "error";
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

// ============================================================================
// API helpers
// ============================================================================

const NO_CACHE = { cache: "no-store" } as const;

export function listAutomations(projectId: string): Promise<AutomationSummary[]> {
  return apiClient("/v1/automations", {
    ...NO_CACHE,
    query: { project_id: projectId },
  });
}

export function createAutomation(
  request: AutomationCreateRequest,
): Promise<AutomationCreateResponse> {
  return apiClient("/v1/automations", { method: "POST", body: request });
}

export interface AutomationPatch
  extends Partial<
    Pick<
      AutomationSummary,
      | "name"
      | "description"
      | "enabled"
      | "event_type"
      | "conditions"
      | "action_config"
    >
  > {
  /** Non-empty string replaces the stored token; omitted keeps it. */
  github_token?: string | null;
}

export function updateAutomation(
  automationId: string,
  patch: AutomationPatch,
): Promise<AutomationSummary> {
  return apiClient(`/v1/automations/${encodeURIComponent(automationId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteAutomation(automationId: string): Promise<void> {
  return apiClient(`/v1/automations/${encodeURIComponent(automationId)}`, {
    method: "DELETE",
  });
}

export function rotateAutomationSecret(
  automationId: string,
): Promise<{ id: string; secret: string }> {
  return apiClient(
    `/v1/automations/${encodeURIComponent(automationId)}/rotate-secret`,
    { method: "POST" },
  );
}

export function testAutomation(
  automationId: string,
): Promise<{ success: boolean; error: string | null }> {
  return apiClient(`/v1/automations/${encodeURIComponent(automationId)}/test`, {
    method: "POST",
  });
}

export function listAutomationExecutions(
  automationId: string,
  limit = 50,
): Promise<{ executions: AutomationExecution[] }> {
  return apiClient(
    `/v1/automations/${encodeURIComponent(automationId)}/executions`,
    { ...NO_CACHE, query: { limit: String(limit) } },
  );
}
