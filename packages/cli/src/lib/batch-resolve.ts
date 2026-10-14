import type { Config } from "./config.ts";
import { apiGet } from "./api.ts";
import { findByPrefix, isCanonicalBatchId, UnresolvedIdError } from "./prefix.ts";

/**
 * A complete batch id, usable verbatim — a canonical id (`bch_` + 24 hex) or
 * a legacy pre-canonical id (32+ chars). Anything else may be a prefix.
 * Canonical ids are 28 chars, so a bare length threshold can't tell them
 * apart from prefixes; and prefix matching only sees the batches in the
 * backend's default listing window, so full ids must bypass it.
 */
export function isFullBatchId(input: string): boolean {
  return isCanonicalBatchId(input) || input.length >= 32;
}

/** Resolve a Batch Run ID from a full id or unique prefix.
 *
 * Full ids pass through untouched; shorter inputs are matched against the
 * batch list (`--project` scoped when configured). The backend filters by
 * `id_prefix` and skips its facets; a backend from before that parameter
 * ignores it and returns its newest page, so the match also runs here.
 */
export async function resolveBatchId(
  backendUrl: string,
  prefix: string,
  config: Config,
): Promise<string> {
  if (isFullBatchId(prefix)) {
    return prefix;
  }

  const params: Record<string, string> = { id_prefix: prefix, page_size: "100" };
  if (config.projectId) params.project = config.projectId;

  // The backend returns a paginated payload ({data: [...]}); accept a bare
  // array from older deployments too.
  const payload = await apiGet<
    Array<{ id: string }> | { data: Array<{ id: string }> }
  >(backendUrl, "/v1/agent-task-batch-runs", params, config);
  const batches = Array.isArray(payload) ? payload : payload.data;
  const result = findByPrefix(batches, prefix, (b) => b.id);
  if (result.status === "none") {
    throw new UnresolvedIdError(
      `No batch id starts with "${prefix}". Check the id, or use the full ` +
        `batch id (a backend older than id-prefix search only looks at its ` +
        `100 most recent batches).`,
    );
  }
  if (result.status === "ambiguous") {
    throw new Error(
      `Batch ID prefix "${prefix}" matches multiple batches: ${result.items
        .map((b) => b.id)
        .join(", ")}`,
    );
  }
  return result.item.id;
}
