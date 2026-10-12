/**
 * Task Notes — a Project's durable knowledge about a Folder, Task, or Test.
 *
 * Shared by `apo notes`, `apo runs show` and `apo task show`: the wire types,
 * the reads, and the rendering, so a Note reads the same wherever it appears.
 * A Note never changes a verdict.
 */

import { existsSync } from "fs";

import type { Config } from "./config.ts";
import { dim, yellow } from "./format.ts";
import { findTaskMetaById } from "./task-meta.ts";

export type TaskNoteScope = "folder" | "task" | "test";

export type TaskNote = {
  id: string;
  scope: TaskNoteScope;
  folder: string | null;
  task_id: string | null;
  test_id: string | null;
  body: string;
  /** The Task Definition Revision the Note was written against (null for Folder Notes). */
  task_definition_revision_id: string | null;
  created_by_user_id: string | null;
  created_by_label: string | null;
  created_via: "session" | "api_key" | "open_dev";
  created_at: string;
  updated_by_user_id: string | null;
  updated_by_label: string | null;
  updated_via: "session" | "api_key" | "open_dev";
  updated_at: string;
  archived_at: string | null;
  /** Set when read for a Run: whether the Note's Task Definition Revision
   * matches the Run's. Null/absent when either side is unknown. */
  task_definition_revision_matches_run?: boolean | null;
};

export type TaskNoteList = { notes: TaskNote[] };

export function notesPath(projectId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/task-notes`;
}

/**
 * A Task ref as the backend keys Notes: the folder-scoped id. A bare name
 * resolves through the local task root when it is unique there; anything the
 * root does not know is used as given (the Task may only exist in the catalog).
 */
export function resolveNoteTaskId(config: Config, ref: string): string {
  if (!existsSync(config.taskRoot)) return ref;
  return findTaskMetaById(config.taskRoot, ref)?.id ?? ref;
}

/** A Note body from the remaining arguments, or from stdin when given `-`. */
export async function readNoteBody(parts: string[]): Promise<string> {
  if (parts.length === 1 && parts[0] === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  return parts.join(" ");
}

export type NotesForRun = {
  /** Folder and Task Notes, shown once above the Checks. */
  general: TaskNote[];
  byTest: Map<string, TaskNote[]>;
};

export function notesForRun(notes: TaskNote[]): NotesForRun {
  const general: TaskNote[] = [];
  const byTest = new Map<string, TaskNote[]>();
  for (const note of notes) {
    if (note.scope === "test" && note.test_id) {
      byTest.set(note.test_id, [...(byTest.get(note.test_id) ?? []), note]);
    } else {
      general.push(note);
    }
  }
  return { general, byTest };
}

/** Where a Note sits, as a short label: the Folder path, `task`, or `test <id>`. */
export function scopeLabel(note: TaskNote): string {
  if (note.scope === "folder") return note.folder ?? "folder";
  if (note.scope === "task") return "task";
  return `test ${note.test_id}`;
}

/**
 * One Note as indented lines. The first line carries the scope label; the
 * attribution and id follow the body, so the text reads first.
 */
export function formatNote(note: TaskNote, opts: { indent: string; label: string }): string[] {
  const [first = "", ...rest] = note.body.split("\n");
  const lines = [`${opts.indent}${yellow(opts.label)} ${dim("·")} ${first}`];
  // A fixed hanging indent: labels can be long Test names, and aligning under
  // them would push the text off the screen.
  const continuation = `${opts.indent}  `;
  for (const line of rest) lines.push(`${continuation}${line}`);

  const creator = note.created_by_label ?? note.created_by_user_id ?? note.created_via;
  const updater = note.updated_by_label ?? note.updated_by_user_id ?? note.updated_via;
  const attribution = creator === updater ? creator : `created by ${creator} · updated by ${updater}`;
  const meta = [attribution, note.updated_at.slice(0, 10), note.id];
  if (note.task_definition_revision_matches_run === false) meta.push("different task revision");
  if (note.archived_at) meta.push("archived");
  lines.push(dim(`${continuation}(${meta.join(" · ")})`));
  return lines;
}
