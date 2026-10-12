/**
 * Pure model for Task Notes on the run page. Mirrors the CLI's
 * `notesForRun` (packages/cli/src/lib/task-notes.ts) so a Note sits in the
 * same place in `apo runs show` and here. Kept free of "use client".
 */
import type { TaskNote } from "@/lib/agent-task-api";

export interface NotesForRun {
  /** Folder and Task Notes, shown once above the checks. */
  general: TaskNote[];
  /** Test Notes keyed by test id (the check's `id`). */
  byTest: Map<string, TaskNote[]>;
}

export function notesForRun(notes: ReadonlyArray<TaskNote> | null | undefined): NotesForRun {
  const general: TaskNote[] = [];
  const byTest = new Map<string, TaskNote[]>();
  for (const note of notes ?? []) {
    if (note.scope === "test") {
      if (!note.test_id) continue;
      byTest.set(note.test_id, [...(byTest.get(note.test_id) ?? []), note]);
    } else {
      general.push(note);
    }
  }
  return { general, byTest };
}

/** Where a general Note sits: the Folder path, or "Task". */
export function noteScopeLabel(note: TaskNote): string {
  if (note.scope === "folder") return note.folder ?? "Folder";
  if (note.scope === "task") return "Task";
  return "Test";
}

/** "label · YYYY-MM-DD" — who wrote it and when it last changed. */
export function noteAttribution(note: TaskNote): string {
  const who = note.created_by_label ?? note.created_by_user_id ?? "unknown";
  return `${who} · ${note.updated_at.slice(0, 10)}`;
}
