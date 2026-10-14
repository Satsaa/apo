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
 * row or a check and opening it again renders from memory instead of waiting
 * on the network. Run details and comparison evidence can change after they
 * are read (a correction, a rejudge, a note), so a reopened row shows the
 * kept copy and then refreshes it (`fresh`). Sources are kept only when they
 * are pinned — a run's definition or a file at a commit — and never refreshed.
 */

type Held<T> = { promise: Promise<T>; release: () => void };

const UNFINISHED = new Set(["running", "pending"]);

// A few open rows' worth of both sides; each detail can carry a transcript.
const runDetails = createPromiseCache<AgentTaskRunDetail>({
  keep: (run) => !UNFINISHED.has(run.status),
  maxEntries: 8,
});

export const loadTaskRunDetail = (runId: string, fresh = false): Held<AgentTaskRunDetail> =>
  runDetails.get(runId, (signal) => getAgentTaskRun(runId, signal), { fresh });

export const peekTaskRunDetail = (runId: string): AgentTaskRunDetail | undefined =>
  runDetails.peek(runId);

// One cache per loader: a loader is bound to one frozen comparison, and a new
// comparison brings a new loader. A comparison view opens one task at a time
// so that only one evidence pair is in memory; keeping that one pair after it
// closes is enough to reopen it at once.
const evidenceByLoader = new WeakMap<TaskComparisonEvidenceLoader, PromiseCache<LoadedTaskComparisonEvidence>>();

const evidenceCache = (loader: TaskComparisonEvidenceLoader): PromiseCache<LoadedTaskComparisonEvidence> => {
  let cache = evidenceByLoader.get(loader);
  if (!cache) {
    cache = createPromiseCache({ keep: ({ left, right }) => Boolean(left || right), maxEntries: 1 });
    evidenceByLoader.set(loader, cache);
  }
  return cache;
};

export const loadComparisonEvidence = (
  loader: TaskComparisonEvidenceLoader,
  taskId: string,
  fresh = false,
): Held<LoadedTaskComparisonEvidence> =>
  evidenceCache(loader).get(taskId, (signal) => loader(taskId, signal), { fresh });

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

/** A check's resolved source, and whether only pinned reads produced it. */
export interface ResolvedCheckSource {
  source: CheckSource;
  pinned: boolean;
}

// One entry per check; the file reads underneath are shared.
const checkSources = createPromiseCache<ResolvedCheckSource>({ keep: ({ pinned }) => pinned, maxEntries: 64 });

export const loadResolvedCheckSource = (
  key: string,
  load: () => Promise<ResolvedCheckSource>,
): Held<ResolvedCheckSource> => checkSources.get(key, load);

export const peekResolvedCheckSource = (key: string): ResolvedCheckSource | undefined => checkSources.peek(key);
