/**
 * `apo notes archive <note-id>` — retire a Task Note that stopped being true.
 *
 * Archived Notes leave `runs show` and default listings but stay readable with
 * `apo notes list --archived`; `apo notes restore` brings one back.
 */

import { parseArgs } from "../lib/args.ts";
import { apiPatch } from "../lib/api.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson } from "../lib/format.ts";
import type { TaskNote } from "../lib/task-notes.ts";

export async function run(argv: string[]): Promise<number> {
  return setArchived(argv, true);
}

export async function setArchived(argv: string[], archived: boolean): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const verb = archived ? "archive" : "restore";

  const noteId = positional[0];
  if (!noteId) {
    console.error("Missing argument: <note-id>");
    console.error(dim(`Usage: apo notes ${verb} <note-id>`));
    return 2;
  }

  let note: TaskNote;
  try {
    note = await apiPatch<TaskNote>(config.backendUrl, `/v1/task-notes/${encodeURIComponent(noteId)}`, { archived }, config);
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(note));
    return 0;
  }
  console.log(`${archived ? "Archived" : "Restored"} ${note.id}`);
  return 0;
}
