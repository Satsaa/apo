/**
 * `apo notes add <task-id> [--test <test-id>] <text…>` /
 * `apo notes add --folder <path> <text…>` — write a Task Note.
 *
 * A Note records what running a Task taught the Project: a criterion audited
 * and found sound, a judge quirk, a normal score range. It never changes a
 * verdict. `<text…>` may be `-` to read the body from stdin. Never prompts.
 */

import { parseArgs, getFlagValue } from "../lib/args.ts";
import { apiPost } from "../lib/api.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson } from "../lib/format.ts";
import {
  formatNote,
  notesPath,
  readNoteBody,
  resolveNoteTaskId,
  scopeLabel,
  type TaskNote,
} from "../lib/task-notes.ts";

const USAGE = "Usage: apo notes add <task-id> [--test <test-id>] <text…> | apo notes add --folder <path> <text…>";

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  if (!config.projectId) {
    console.error("No project selected (run: apo project use).");
    return 2;
  }

  const folder = getFlagValue(flags, "folder");
  const testId = getFlagValue(flags, "test");
  if (folder !== undefined && testId !== undefined) {
    console.error("--test applies to a Task Note; a Folder Note takes no --test");
    return 2;
  }

  const taskRef = folder !== undefined ? undefined : positional[0];
  const bodyParts = folder !== undefined ? positional : positional.slice(1);
  if (folder === undefined && !taskRef) {
    console.error("Missing <task-id> (or --folder <path>)");
    console.error(dim(USAGE));
    return 2;
  }
  const body = (await readNoteBody(bodyParts)).trim();
  if (!body) {
    console.error("Missing note text");
    console.error(dim(USAGE));
    return 2;
  }

  const target = folder !== undefined
    ? { folder }
    : { task_id: resolveNoteTaskId(config, taskRef!), ...(testId !== undefined ? { test_id: testId } : {}) };

  let note: TaskNote;
  try {
    note = await apiPost<TaskNote>(config.backendUrl, notesPath(config.projectId), { ...target, body }, config);
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(note));
    return 0;
  }
  const where = note.scope === "folder" ? `folder ${note.folder}` : note.task_id;
  console.log(`Noted on ${where}:`);
  console.log(formatNote(note, { indent: "  ", label: scopeLabel(note) }).join("\n"));
  return 0;
}
