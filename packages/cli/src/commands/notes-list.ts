/**
 * `apo notes list [<task-id>] [--folder <path>] [--archived]` — read Task Notes.
 *
 * With a Task: what applies to it (its ancestor Folders, the Task, its Tests).
 * With --folder: everything at or under the Folder. With neither: the Project.
 */

import { parseArgs, getBoolFlag, getFlagValue } from "../lib/args.ts";
import { apiGet } from "../lib/api.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import {
  formatNote,
  notesPath,
  resolveNoteTaskId,
  scopeLabel,
  type TaskNote,
  type TaskNoteList,
} from "../lib/task-notes.ts";

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  if (!config.projectId) {
    console.error("No project selected (run: apo project use).");
    return 2;
  }

  const folder = getFlagValue(flags, "folder");
  const taskRef = positional[0];
  if (folder !== undefined && taskRef) {
    console.error("Give a <task-id> or --folder, not both");
    return 2;
  }

  const params: Record<string, string> = {};
  if (taskRef) params.task_id = resolveNoteTaskId(config, taskRef);
  if (folder !== undefined) params.folder = folder;
  if (getBoolFlag(flags, "archived")) params.include_archived = "true";

  let notes: TaskNote[];
  try {
    notes = (await apiGet<TaskNoteList>(config.backendUrl, notesPath(config.projectId), params, config)).notes;
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson({ notes }));
    return 0;
  }
  if (notes.length === 0) {
    console.log(dim("No notes."));
    return 0;
  }

  // Group by what the Note is about, so a Folder or Project listing reads
  // Task by Task.
  let heading: string | null = null;
  for (const note of notes) {
    const about = note.scope === "folder" ? `folder ${note.folder}` : `task ${note.task_id}`;
    if (about !== heading) {
      console.log(bold(`${heading === null ? "" : "\n"}${about}`));
      heading = about;
    }
    console.log(formatNote(note, { indent: "  ", label: scopeLabel(note) }).join("\n"));
  }
  return 0;
}
