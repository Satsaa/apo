import {
  getAgentTaskRun,
  readTaskDefinitionSource,
  readTaskFile,
  type AgentTaskRunDetail,
  type TaskFileContentResponse,
} from "./agent-task-api";
import type { LoadedTaskComparisonEvidence, TaskComparisonEvidenceLoader } from "./agent-task-view-api";
import type { CheckSource } from "./load-check-source";
import { createPromiseCache, type PromiseCache } from "./promise-cache";

/**
 * Page-lifetime caches for what an expanded compare row loads, so collapsing a
 * row or a check and opening it again reads from memory instead of the
 * network. Everything cached here is fixed once written: a finished run's
 * detail, a frozen comparison's evidence, a run's pinned definition and a
 * file at a commit. A run still in progress is fetched fresh each time.
 */

type Held<T> = { promise: Promise<T>; release: () => void };

const UNFINISHED = new Set(["running", "pending"]);

const runDetails = createPromiseCache<AgentTaskRunDetail>({
  keep: (run) => !UNFINISHED.has(run.status),
});

export const loadTaskRunDetail = (runId: string): Held<AgentTaskRunDetail> =>
  runDetails.get(runId, () => getAgentTaskRun(runId));

export const peekTaskRunDetail = (runId: string): AgentTaskRunDetail | undefined =>
  runDetails.peek(runId);

// One cache per loader: a loader is bound to one frozen comparison, and a new
// comparison brings a new loader.
const evidenceByLoader = new WeakMap<TaskComparisonEvidenceLoader, PromiseCache<LoadedTaskComparisonEvidence>>();

const evidenceCache = (loader: TaskComparisonEvidenceLoader): PromiseCache<LoadedTaskComparisonEvidence> => {
  let cache = evidenceByLoader.get(loader);
  if (!cache) {
    cache = createPromiseCache();
    evidenceByLoader.set(loader, cache);
  }
  return cache;
};

export const loadComparisonEvidence = (
  loader: TaskComparisonEvidenceLoader,
  taskId: string,
): Held<LoadedTaskComparisonEvidence> => evidenceCache(loader).get(taskId, (signal) => loader(taskId, signal));

export const peekComparisonEvidence = (
  loader: TaskComparisonEvidenceLoader,
  taskId: string,
): LoadedTaskComparisonEvidence | undefined => evidenceCache(loader).peek(taskId);

// File reads are shared by every check of a task and small, so they are
// never cancelled: a check closed mid-load leaves its file to the next one.
const sources = createPromiseCache<TaskFileContentResponse>();

export const loadDefinitionSource = (runId: string, filePath: string): Promise<TaskFileContentResponse> =>
  sources.get(JSON.stringify(["definition", runId, filePath]), (signal) =>
    readTaskDefinitionSource(runId, filePath, signal),
  ).promise;

/** Without a commit the file is read from the working tree, which can change. */
export const loadTaskFile = (
  taskId: string,
  filePath: string,
  projectId: string,
  commitSha?: string | null,
): Promise<TaskFileContentResponse> =>
  commitSha
    ? sources.get(JSON.stringify(["file", projectId, taskId, filePath, commitSha]), (signal) =>
        readTaskFile(taskId, filePath, projectId, commitSha, signal),
      ).promise
    : readTaskFile(taskId, filePath, projectId, commitSha);

/** The resolved source of one check, so a reopened check renders at once. */
export const checkSources = createPromiseCache<CheckSource>();
