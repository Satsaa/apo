import { getFlagValue, parseArgs } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson, formatTable } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { reportCommandError } from "../lib/command-error.ts";

type AutomationSummary = {
  id: string;
  name: string;
  event_type: string;
  action_type: string;
  action_config: Record<string, unknown>;
  enabled: boolean;
  consecutive_failures: number;
  last_delivery_status: string | null;
};

function describeAction(automation: AutomationSummary): string {
  if (automation.action_type === "slack") {
    return `slack ${String(automation.action_config.url_display ?? "channel")}`;
  }
  if (automation.action_type === "webhook") {
    return `webhook ${String(automation.action_config.url ?? "")}`;
  }
  return `github_issue ${String(automation.action_config.owner ?? "")}/${String(
    automation.action_config.repo ?? "",
  )}`;
}

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const params: Record<string, string> = {};
  const projectId = getFlagValue(flags, "project") ?? config.projectId;
  if (projectId) params.project_id = projectId;

  let automations: AutomationSummary[];
  try {
    automations = await apiGet<AutomationSummary[]>(
      config.backendUrl,
      "/v1/automations",
      params,
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(automations));
    return 0;
  }

  if (automations.length === 0) {
    console.log(dim("No automations found"));
    return 0;
  }

  const rows = automations.map((automation) => [
    automation.name,
    automation.event_type,
    describeAction(automation),
    automation.enabled ? "enabled" : dim("disabled"),
    automation.last_delivery_status ?? dim("-"),
  ]);
  console.log(
    formatTable(
      ["Name", "Event", "Action", "State", "Last Delivery"],
      rows,
    ),
  );
  console.log("");
  console.log(
    dim(`${automations.length} automation${automations.length === 1 ? "" : "s"}`),
  );

  return 0;
}
