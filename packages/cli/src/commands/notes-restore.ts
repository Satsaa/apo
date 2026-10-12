/** `apo notes restore <note-id>` — bring an archived Task Note back. */

import { setArchived } from "./notes-archive.ts";

export async function run(argv: string[]): Promise<number> {
  return setArchived(argv, false);
}
