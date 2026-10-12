/**
 * Task Notes in the CLI: `apo notes add|list|edit|archive|restore`, and the
 * Notes `apo runs show` prints from the Run detail — Folder and Task Notes
 * above the Checks, a Test's Notes under it, marked when the Task changed since.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { run as add } from "../src/commands/notes-add.ts";
import { run as archive } from "../src/commands/notes-archive.ts";
import { run as edit } from "../src/commands/notes-edit.ts";
import { run as list } from "../src/commands/notes-list.ts";
import { run as restore } from "../src/commands/notes-restore.ts";
import { run as runsShow } from "../src/commands/runs-show.ts";
import { stripAnsi } from "../src/lib/format.ts";
import type { TaskNote } from "../src/lib/task-notes.ts";

const BACKEND = ["--backend", "http://backend.test", "--project", "p1", "--dir", "/nonexistent-task-root"];
const RUN_ID = "0123456789abcdef0123456789abcdef";
const TASK = "harvey-lab/assess-risk";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function note(overrides: Partial<TaskNote> = {}): TaskNote {
  return {
    id: "note_aaaa",
    scope: "task",
    folder: null,
    task_id: TASK,
    test_id: null,
    body: "Opus 5.5 scores 45-47/48",
    task_definition_revision_id: "rev1",
    created_by_user_id: "u1",
    created_by_label: "u1@test.com",
    created_via: "api_key",
    created_at: "2026-10-12T09:00:00Z",
    updated_by_user_id: "u1",
    updated_at: "2026-10-12T09:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => out.push(stripAnsi(args.join(" ")));
  console.error = (...args: unknown[]) => err.push(stripAnsi(args.join(" ")));
  return { out, err, restore: () => { console.log = log; console.error = error; } };
}

function request(fetchMock: ReturnType<typeof vi.spyOn>, index = -1): { url: URL; method: string; body: unknown } {
  const call = fetchMock.mock.calls.at(index)!;
  const init = call[1] as RequestInit | undefined;
  return {
    url: new URL(String(call[0])),
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

describe("notes add", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes a Test Note with the remaining words as its body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(note({ scope: "test", test_id: "C-021", body: "audited: sound" }), 201),
    );
    const io = capture();

    const code = await add([TASK, "--test", "C-021", "audited:", "sound", ...BACKEND]);
    io.restore();

    expect(code).toBe(0);
    const sent = request(fetchMock);
    expect(sent.method).toBe("POST");
    expect(sent.url.pathname).toBe("/v1/projects/p1/task-notes");
    expect(sent.body).toEqual({ task_id: TASK, test_id: "C-021", body: "audited: sound" });
    expect(io.out.join("\n")).toContain("test C-021 · audited: sound");
  });

  it("writes a Folder Note without a task id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(note({ scope: "folder", folder: "harvey-lab", task_id: null }), 201),
    );
    const io = capture();

    const code = await add(["--folder", "harvey-lab", "judge", "quirk", ...BACKEND]);
    io.restore();

    expect(code).toBe(0);
    expect(request(fetchMock).body).toEqual({ folder: "harvey-lab", body: "judge quirk" });
  });

  it("refuses --test on a Folder Note and an empty body before calling the backend", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const io = capture();

    const withTest = await add(["--folder", "harvey-lab", "--test", "C-1", "text", ...BACKEND]);
    const noBody = await add([TASK, ...BACKEND]);
    io.restore();

    expect([withTest, noBody]).toEqual([2, 2]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the backend's error contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ detail: { kind: "invalid_body", msg: "body must be 3–4000 characters" } }, 422),
    );
    const io = capture();

    const code = await add([TASK, "ab", ...BACKEND]);
    io.restore();

    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain("invalid_body");
  });
});

describe("notes list", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists what applies to a Task, grouped by what each Note is about", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        notes: [
          note({ id: "note_f", scope: "folder", folder: "harvey-lab", task_id: null, body: "judge quirk" }),
          note({ id: "note_t" }),
          note({ id: "note_c", scope: "test", test_id: "C-021", body: "audited" }),
        ],
      }),
    );
    const io = capture();

    const code = await list([TASK, ...BACKEND]);
    io.restore();

    expect(code).toBe(0);
    expect(request(fetchMock).url.searchParams.get("task_id")).toBe(TASK);
    const text = io.out.join("\n");
    expect(text).toMatch(/folder harvey-lab\n {2}harvey-lab · judge quirk/);
    expect(text).toMatch(/task harvey-lab\/assess-risk\n {2}task · Opus 5.5 scores 45-47\/48/);
    expect(text).toContain("test C-021 · audited");
    expect(text).toContain("(u1@test.com · 2026-10-12 · note_c)");
  });

  it("asks for archived Notes under a Folder", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ notes: [] }));
    const io = capture();

    await list(["--folder", "harvey-lab", "--archived", ...BACKEND]);
    io.restore();

    const params = request(fetchMock).url.searchParams;
    expect(params.get("folder")).toBe("harvey-lab");
    expect(params.get("include_archived")).toBe("true");
    expect(io.out).toEqual(["No notes."]);
  });
});

describe("notes edit / archive / restore", () => {
  afterEach(() => vi.restoreAllMocks());

  it("patches the body, the archived flag on, and off", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(note({ body: "re-checked" })))
      .mockResolvedValueOnce(jsonResponse(note({ archived_at: "2026-10-13T00:00:00Z" })))
      .mockResolvedValueOnce(jsonResponse(note()));
    const io = capture();

    expect(await edit(["note_aaaa", "re-checked", ...BACKEND])).toBe(0);
    expect(await archive(["note_aaaa", ...BACKEND])).toBe(0);
    expect(await restore(["note_aaaa", ...BACKEND])).toBe(0);
    io.restore();

    const bodies = [0, 1, 2].map((i) => request(fetchMock, i));
    expect(bodies.map((b) => [b.method, b.url.pathname, b.body])).toEqual([
      ["PATCH", "/v1/task-notes/note_aaaa", { body: "re-checked" }],
      ["PATCH", "/v1/task-notes/note_aaaa", { archived: true }],
      ["PATCH", "/v1/task-notes/note_aaaa", { archived: false }],
    ]);
  });
});

describe("runs show with Task Notes", () => {
  afterEach(() => vi.restoreAllMocks());

  function runDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: RUN_ID,
      task_id: TASK,
      task_path: `tasks/${TASK}`,
      batch_run_id: "batch-1",
      adapter_name: "chat",
      status: "failed",
      pass_result: false,
      started_at: "2026-10-12T09:00:00Z",
      completed_at: "2026-10-12T09:10:00Z",
      trace_run_id: null,
      error_message: null,
      total_cost: 1,
      total_tokens: null,
      total_checks: 2,
      passed_checks: 1,
      failed_checks: 1,
      trigger: null,
      checks_json: [
        { id: "C-020", pass: true, reasoning: "fine" },
        { id: "C-021", pass: false, reasoning: "no mixed-motive discussion" },
      ],
      deliverables_json: null,
      transcript_json: null,
      ...overrides,
    };
  }

  it("prints Folder and Task Notes above the Checks and a Test's Note under its failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        runDetail({
          task_notes: [
            note({ id: "note_f", scope: "folder", folder: "harvey-lab", task_id: null, body: "judge quirk", task_definition_revision_id: null }),
            note({ id: "note_t", task_changed_since: false }),
            note({ id: "note_c", scope: "test", test_id: "C-021", body: "audited: misses are real\nsee run_78226dd5", task_changed_since: true }),
            note({ id: "note_p", scope: "test", test_id: "C-020", body: "passing-test note" }),
          ],
        }),
      ),
    );
    const io = capture();

    const code = await runsShow([RUN_ID, ...BACKEND]);
    io.restore();

    expect(code).toBe(0);
    const text = io.out.join("\n");
    const notesAt = text.indexOf("Notes:");
    const checksAt = text.indexOf("Checks:\n");
    expect(notesAt).toBeGreaterThan(-1);
    expect(notesAt).toBeLessThan(checksAt);
    expect(text).toContain("harvey-lab · judge quirk");
    expect(text).toContain("task · Opus 5.5 scores 45-47/48");

    const failure = text.slice(text.indexOf("FAIL C-021"));
    expect(failure).toMatch(/FAIL C-021\n {6}note · audited: misses are real\n {8}see run_78226dd5\n {8}\(u1@test\.com · 2026-10-12 · note_c · task changed since\)\n {6}no mixed-motive discussion/);
    // A passing Test's Note waits for --verbose.
    expect(text).not.toContain("passing-test note");
  });

  it("shows a passing Test's Note with --verbose", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(runDetail({ task_notes: [note({ scope: "test", test_id: "C-020", body: "passing-test note" })] })),
    );
    const io = capture();

    await runsShow([RUN_ID, "--verbose", ...BACKEND]);
    io.restore();

    expect(io.out.join("\n")).toContain("note · passing-test note");
  });

  it("renders as before against a backend without Task Notes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(runDetail()));
    const io = capture();

    const code = await runsShow([RUN_ID, ...BACKEND]);
    io.restore();

    expect(code).toBe(0);
    expect(io.out.join("\n")).not.toContain("Notes:");
    expect(io.out.join("\n")).not.toContain("note ·");
  });
});
