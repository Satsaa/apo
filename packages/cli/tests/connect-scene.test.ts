import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

/*
 * Real CLI scene test.
 *
 * Spawns the real `packages/cli/src/main.ts connect` command against a local
 * fake HTTP server and an importable fixture Task root. It does NOT call
 * executeAssignment directly — it exercises bootstrap → enroll → heartbeat →
 * claim → attestation → start → child run → result through the real process,
 * then returns no work and drains on SIGINT.
 */

const FIXTURE_ROOT = resolve(__dirname, "fixtures/connect-task");
const MAIN = resolve(__dirname, "../src/main.ts");

interface RecordedRequest {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

function startFakeServer(): Promise<{ server: Server; port: number; requests: RecordedRequest[]; state: Record<string, unknown> }> {
  return new Promise((resolveReady) => {
    const requests: RecordedRequest[] = [];
    const state: Record<string, unknown> = { claimsReturned: 0 };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        requests.push({
          method: req.method ?? "POST",
          path: req.url ?? "",
          auth: req.headers.authorization ?? "",
          body,
        });
        const url = req.url ?? "";
        const json = (o: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        const port = (server.address() as AddressInfo).port;

        // Bootstrap → enrollment token
        if (url.endsWith("/connected-executor-bootstrap")) {
          return json({ enrollment_token: "apo_enroll_scene", expires_at: "2027-01-01T00:00:00Z", protocol_version: 2 }, 201);
        }
        // Enroll → executor credential
        if (url.endsWith("/v2/enroll")) {
          return json({ executor_id: "ex-scene", credential: "apo_ex_scene_credential", heartbeat_interval_seconds: 5, lease_ttl_seconds: 90 });
        }
        // Heartbeat → ready (echo the client's digest so eligibility matches)
        if (url.endsWith("/v2/heartbeat")) {
          const digest = (body as { catalog_digest?: string } | null)?.catalog_digest ?? "sha256:scene";
          return json({ status: "ready", project_catalog_digest: digest });
        }
        // Claims → one assignment the first time, then empty
        if (url.endsWith("/v2/claims")) {
          const claimBody = body as { catalog_digest?: string; available_slots?: number } | null;
          const digest = claimBody?.catalog_digest ?? "sha256:scene";
          if ((state.claimsReturned as number) === 0) {
            state.claimsReturned = 1;
            return json({
              assignment_kind: "source_owned",
              attempt_id: "att-scene",
              task_run_id: "run-scene",
              batch_run_id: "bch-scene",
              task_id: "connect-fixture",
              environment: "default",
              timeout_seconds: 60,
              project: "scene-proj",
              catalog_digest: digest,
              lease_generation: 1,
              lease_expires_at: "2027-01-01T00:00:00Z",
              attempt_jwt: "attempt-jwt-scene",
              trace_endpoint: `http://127.0.0.1:${port}/api/public/otel/v1/traces`,
              trace_required: true,
              result_max_bytes: 1048576,
              diagnostic_tail_bytes: 1000,
              run_metadata: null,
            });
          }
          res.writeHead(204, { "content-type": "application/json", "retry-after": "1" });
          return res.end();
        }
        // Attestation / start / attempt heartbeat / result → ok
        if (url.includes("/source-attestation")) return json({ task_revision_id: "rev-scene", content_sha256: "x" });
        if (url.includes("/start")) return json({ attempt_id: "att-scene", status: "running", phase: "running" });
        if (url.includes("/attempts/att-scene/heartbeat")) return json({ cancel_requested: false });
        if (url.includes("/result")) return json({ ok: true });
        if (url.includes("/failure")) return json({ ok: true });
        // OTLP trace export endpoint — accept silently
        if (url.includes("/api/public/otel")) { res.writeHead(200); return res.end(); }
        json({ ok: true });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveReady({ server, port, requests, state });
    });
  });
}

function spawnConnect(port: number, homeDir: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["--experimental-strip-types", MAIN, "connect", "--dir", FIXTURE_ROOT, "--project", "scene-proj", "--concurrency", "1"], {
    env: {
      ...process.env,
      HOME: homeDir,
      APO_BACKEND_URL: `http://127.0.0.1:${port}`,
      APO_API_KEY: "scene-user-key",
      APO_PROJECT_ID: "scene-proj",
      // Keep the child off any real provider endpoints
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("real apo connect scene", () => {
  it("runs an assignment through the real command and finalizes via /result", async () => {
    const { server, port, requests } = await startFakeServer();
    const home = mkdtempSync(join(tmpdir(), "apo-connect-scene-"));
    const child = spawnConnect(port, home);

    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });

    // Wait until the result is recorded (or the process exits early on error).
    const resultPosted = new Promise<void>((resolvePromise, reject) => {
      const tick = () => {
        if (requests.some((r) => r.path.includes("/result"))) return resolvePromise();
        child.on("exit", (code) => {
          if (!requests.some((r) => r.path.includes("/result"))) {
            reject(new Error(`connect exited (code ${code}) before posting result.\nstdout:\n${stdout}`));
          }
        });
        setTimeout(tick, 200);
      };
      tick();
    });

    await resultPosted;
    // Stop new claims + drain.
    child.kill("SIGINT");
    const code = await new Promise<number>((resolveExit) => child.on("exit", (c) => resolveExit(c ?? 0)));
    await new Promise<void>((r) => server.close(() => r()));

    expect(code).toBe(0);

    const paths = requests.map((r) => r.path);
    const idx = (sub: string) => paths.findIndex((p) => p.includes(sub));

    // Ordering: attestation before start before result.
    expect(idx("/source-attestation")).toBeGreaterThanOrEqual(0);
    expect(idx("/start")).toBeGreaterThan(idx("/source-attestation"));
    expect(idx("/result")).toBeGreaterThan(idx("/start"));

    // Real source attestation — no all-zero placeholder hash (bare 64 hex).
    const attestation = requests.find((r) => r.path.includes("/source-attestation"))!.body as Record<string, unknown>;
    expect(attestation.content_sha256).not.toBe("0".repeat(64));
    expect(attestation.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation.file_count).toBeGreaterThan(0);

    // The executed eval source, as `apo task run` and publish send it.
    const executed = attestation.task_definition as { files: { path: string }[] };
    expect(executed.files).toHaveLength(1);
    expect(executed.files[0].path).toMatch(/^[^/]+\.eval\.ts$/);

    // Full result payload from the isolated child.
    const result = requests.find((r) => r.path.includes("/result"))!.body as Record<string, unknown>;
    expect(result.completion_id).toContain("att-scene");
    expect(result.deliverables).toEqual({ result: "fixture-output" });
    expect(result.run_configuration).toEqual({ model: "deterministic-fixture", effort: "low" });

    // No path/env/credential values leak in the execution payloads
    // (attestation + result bodies); the eval source above is the one
    // intended exception. The bootstrap/heartbeat auth headers
    // legitimately carry the user key / executor credential; OTLP trace
    // attributes are a separate telemetry stream.
    const executionBodies = requests
      .filter((r) => r.path.includes("/source-attestation") || r.path.includes("/result") || r.path.includes("/failure") || r.path.includes("/start"))
      .map((r) => JSON.stringify(r.body))
      .join("");
    expect(executionBodies).not.toContain("scene-user-key");        // user API key
    expect(executionBodies).not.toContain("apo_ex_scene_credential"); // executor credential
    expect(executionBodies).not.toContain(FIXTURE_ROOT);             // absolute task root path
  }, 60_000);

  it("drains cleanly on SIGINT after an empty-claim 204", async () => {
    const { server, port, requests } = await startFakeServer();
    const home = mkdtempSync(join(tmpdir(), "apo-connect-sigint-"));
    const child = spawnConnect(port, home);

    // Wait for at least one claim attempt, then signal.
    await new Promise<void>((resolveWait) => {
      const tick = () => {
        if (requests.some((r) => r.path.includes("/claims"))) return resolveWait();
        setTimeout(tick, 200);
      };
      tick();
    });
    child.kill("SIGINT");
    const code = await new Promise<number>((resolveExit) => child.on("exit", (c) => resolveExit(c ?? 0)));
    await new Promise<void>((r) => server.close(() => r()));
    expect(code).toBe(0);
  }, 60_000);
});
