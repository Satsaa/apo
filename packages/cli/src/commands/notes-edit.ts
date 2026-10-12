/**
 * `apo notes edit <note-id> <text…>` — replace a Task Note's text.
 *
 * The Note is re-anchored to the Task's current definition: an edited Note
 * speaks for the Task as it is now. `<text…>` may be `-` to read stdin.
 */

import { parseArgs } from "../lib/args.ts";
import { apiPatch } from "../lib/api.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson } from "../lib/format.ts";
import { formatNote, readNoteBody, scopeLabel, type TaskNote } from "../lib/task-notes.ts";

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const [noteId, ...bodyParts] = positional;
  const body = noteId ? (await readNoteBody(bodyParts)).trim() : "";
  if (!noteId || !body) {
    console.error("Missing arguments: <note-id> <text…>");
    console.error(dim("Usage: apo notes edit <note-id> <text…>"));
    return 2;
  }

  let note: TaskNote;
  try {
    note = await apiPatch<TaskNote>(config.backendUrl, `/v1/task-notes/${encodeURIComponent(noteId)}`, { body }, config);
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(note));
    return 0;
  }
  console.log(formatNote(note, { indent: "", label: scopeLabel(note) }).join("\n"));
  return 0;
}
