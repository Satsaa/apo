import { listAutomations, type AutomationSummary } from "@/lib/automations-api";
import { getProject } from "@/lib/projects-api";
import AutomationsClient from "./automations-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automations" };

const EMPTY: AutomationSummary[] = [];

export default async function AutomationsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  let automations = EMPTY;
  let error: string | null = null;
  try {
    automations = await listAutomations(projectId);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to load automations";
  }

  // Automation management is admin-tier; viewers see the list and the
  // execution log but never the mutation controls.
  const canManage = await getProject(projectId)
    .then((project) => project.permissions?.can_manage_project === true)
    .catch(() => false);

  return (
    <AutomationsClient
      projectId={projectId}
      initialAutomations={automations}
      error={error}
      canManage={canManage}
    />
  );
}
