import { getFlagValue, getFlagValues, parseArgs } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { formatJson } from "../lib/format.ts";
import { apiPost } from "../lib/api.ts";
import { reportCommandError } from "../lib/command-error.ts";

type Condition = { field: string; operator: string; value: unknown };

type CreateResponse = {
  id: string;
  name: string;
  event_type: string;
  action_type: string;
  secret?: string | null;
};

function parseConditions(raw: string[]): Condition[] | string {
  const conditions: Condition[] = [];
  for (const item of raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item);
    } catch {
      return `--condition must be JSON, got: ${item}`;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Condition).field !== "string" ||
      typeof (parsed as Condition).operator !== "string" ||
      !("value" in (parsed as object))
    ) {
      return `--condition must be {"field","operator","value"}, got: ${item}`;
    }
    conditions.push(parsed as Condition);
  }
  return conditions;
}

export async function run(argv: string[]): Promise<number> {
  const { flags, multiFlags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const name = getFlagValue(flags, "name");
  const event = getFlagValue(flags, "event");
  const action = getFlagValue(flags, "action") ?? "webhook";
  if (!name) {
    console.error("--name is required");
    return 1;
  }
  if (!event) {
    console.error("--event is required");
    return 1;
  }
  if (action !== "webhook" && action !== "github_issue") {
    console.error("--action must be webhook or github_issue");
    return 1;
  }

  const parsedConditions = parseConditions(getFlagValues(multiFlags, "condition"));
  if (typeof parsedConditions === "string") {
    console.error(parsedConditions);
    return 1;
  }

  const projectId = getFlagValue(flags, "project") ?? config.projectId;
  if (!projectId) {
    console.error("--project or a saved project is required");
    return 1;
  }

  let actionConfig: Record<string, unknown>;
  let githubToken: string | undefined;
  if (action === "webhook") {
    const url = getFlagValue(flags, "url");
    if (!url) {
      console.error("--url is required for webhook actions");
      return 1;
    }
    actionConfig = { url };
  } else {
    const owner = getFlagValue(flags, "owner");
    const repo = getFlagValue(flags, "repo");
    githubToken = getFlagValue(flags, "github-token");
    if (!owner || !repo || !githubToken) {
      console.error(
        "--owner, --repo, and --github-token are required for github_issue actions",
      );
      return 1;
    }
    const labels = getFlagValue(flags, "labels");
    actionConfig = {
      owner,
      repo,
      labels: labels
        ? labels.split(",").map((label) => label.trim()).filter(Boolean)
        : null,
      title: null,
      body: null,
    };
  }

  let created: CreateResponse;
  try {
    created = await apiPost<CreateResponse>(
      config.backendUrl,
      "/v1/automations",
      {
        project_id: projectId,
        name,
        event_type: event,
        conditions: parsedConditions,
        action_type: action,
        action_config: actionConfig,
        ...(githubToken ? { github_token: githubToken } : {}),
      },
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(created));
    return 0;
  }

  console.log(`Created automation ${created.name} (${created.id})`);
  if (created.secret) {
    console.log("");
    console.log("Signing secret (shown once):");
    console.log(created.secret);
  }
  return 0;
}
