import type { TaskNote } from "@/lib/agent-task-api";
import { noteAttribution, noteScopeLabel } from "./task-notes-model";

/**
 * Task Notes, read-only. Folder and Task Notes render once above
 * the checks; a Test's Notes render inside its check. A Note is knowledge,
 * not a verdict, so it stays gray — only the "Task changed since" marker
 * takes the warning tone, because it qualifies whether the Note still holds.
 * Bodies are plain text with line breaks preserved, never parsed as markup.
 */
export function TaskNotesPanel({ notes }: { notes: TaskNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section aria-label="Task notes" className="border border-border bg-card/60 px-4 py-3">
      <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
        Notes
      </h2>
      <ul className="mt-2 space-y-2">
        {notes.map((note) => (
          <li key={note.id}>
            <NoteEntry note={note} label={noteScopeLabel(note)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A Test's Notes inside its expanded check. */
export function TestNotes({ notes }: { notes: TaskNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul aria-label="Test notes" className="space-y-1.5">
      {notes.map((note) => (
        <li key={note.id}>
          <NoteEntry note={note} label="Note" />
        </li>
      ))}
    </ul>
  );
}

function NoteEntry({ note, label }: { note: TaskNote; label: string }) {
  return (
    <div className="text-[12px]">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-foreground">{label}</span>
        <span className="text-muted-foreground">{noteAttribution(note)}</span>
        {note.task_changed_since === true && (
          <span
            className="border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning"
            title="This Note was written against a different version of the Task's eval file than this run used"
          >
            Task changed since
          </span>
        )}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words border-l-2 border-border pl-2.5 text-[13px] leading-relaxed text-foreground/80">
        {note.body}
      </p>
    </div>
  );
}
