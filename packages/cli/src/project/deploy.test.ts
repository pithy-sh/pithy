import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { deployProject, deploySeverity, pendingWarning, summarizeDeploy } from "./deploy";

/** Representative `wrangler deploy` output — the lines deploy scrapes for the version id and url. */
function wranglerOutput(name: string, version: string): string {
  return [
    `Total Upload: 42.00 KiB / gzip: 12.00 KiB`,
    `Deployed ${name} triggers (0.50 sec)`,
    `  https://${name}.acme.workers.dev`,
    `Current Version ID: ${version}`,
  ].join("\n");
}

describe("deployProject", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-deploy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Create `apps/<dir>/wrangler.jsonc` — the only shape a Worker has; there is no root Worker. */
  async function writeWorker(dirName: string, name: string): Promise<void> {
    const at = join(dir, "apps", dirName);
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name }));
  }

  test("deploys each worker, passes --env, and parses the per-worker summary", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");
    const calls: { name: string; args: string[] }[] = [];

    const results = await deployProject({
      projectDir: dir,
      env: "production",
      runDeploy: async (target, args) => {
        calls.push({ name: target.name, args });
        return wranglerOutput(target.name, `ver-${target.name}`);
      },
    });

    expect(calls).toEqual([
      { name: "pithy-api", args: ["deploy", "--env", "production"] },
      { name: "pithy-web", args: ["deploy", "--env", "production"] },
    ]);
    expect(results).toEqual([
      { name: "pithy-api", ok: true, versionId: "ver-pithy-api", url: "https://pithy-api.acme.workers.dev" },
      { name: "pithy-web", ok: true, versionId: "ver-pithy-web", url: "https://pithy-web.acme.workers.dev" },
    ]);
  });

  test("omits --env when no environment is given (each worker's top-level config)", async () => {
    await writeWorker("app", "pithy-app");
    const calls: string[][] = [];

    await deployProject({
      projectDir: dir,
      runDeploy: async (_target, args) => {
        calls.push(args);
        return wranglerOutput("pithy-app", "v1");
      },
    });

    expect(calls).toEqual([["deploy"]]);
  });

  test("records a failed worker, keeps deploying the rest, and reports the failure", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");

    const results = await deployProject({
      projectDir: dir,
      env: "staging",
      runDeploy: async (target) => {
        if (target.name === "pithy-api") throw new Error("upload failed: exit 1");
        return wranglerOutput(target.name, "v2");
      },
    });

    expect(results[0]).toMatchObject({ name: "pithy-api", ok: false });
    expect(results[0]?.error).toMatch(/upload failed/);
    // The second worker still deployed — one failure doesn't abort the batch.
    expect(results[1]).toMatchObject({ name: "pithy-web", ok: true, versionId: "v2" });
  });

  test("surfaces wrangler's captured stderr (PithyError detail), not just the generic message", async () => {
    await writeWorker("app", "pithy-app");

    const results = await deployProject({
      projectDir: dir,
      env: "production",
      // How runWrangler reports a non-zero exit: a public message plus the real output in `detail`.
      runDeploy: async () => {
        throw new InternalError({ message: "wrangler deploy failed.", detail: "exit 1\nAuthentication error [10000]" });
      },
    });

    expect(results[0]?.ok).toBe(false);
    // The CI-relevant reason (the captured stderr), not the generic public message.
    expect(results[0]?.error).toBe("exit 1\nAuthentication error [10000]");
  });

  test("a worker whose output has no version id or url still succeeds with those fields absent", async () => {
    await writeWorker("app", "pithy-app");

    const results = await deployProject({
      projectDir: dir,
      runDeploy: async () => "Deployed. No parseable details here.",
    });

    expect(results).toEqual([{ name: "pithy-app", ok: true }]);
  });

  test("fails when the project has no deployable workers", async () => {
    const failure = await deployProject({ projectDir: dir, runDeploy: async () => "" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/worker/i);
  });

  test("audits a successful deploy per worker, at warning severity for production", async () => {
    await writeWorker("api", "pithy-api");
    const events: CliAuditEvent[] = [];

    await deployProject({
      projectDir: dir,
      env: "production",
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "deploy/worker_deployed",
      outcome: "success",
      severity: "warning",
      resourceType: "cf_worker",
      resourceId: "pithy-api",
      metadata: { worker: "pithy-api", env: "production" },
    });
  });

  test("audits a failed deploy as a failure, and staging stays info severity", async () => {
    await writeWorker("api", "pithy-api");
    const events: CliAuditEvent[] = [];

    await deployProject({
      projectDir: dir,
      env: "staging",
      runDeploy: async () => {
        throw new Error("upload failed");
      },
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "failure", severity: "info" });
    expect(events[0]?.metadata?.error).toMatch(/upload failed/);
  });
});

describe("deploySeverity", () => {
  test("only production is warning; staging, dev, and the top-level worker are info", () => {
    expect(deploySeverity("production")).toBe("warning");
    expect(deploySeverity("staging")).toBe("info");
    expect(deploySeverity(undefined)).toBe("info");
  });
});

describe("summarizeDeploy", () => {
  test("a success line carries the url and version id", () => {
    expect(summarizeDeploy({ name: "pithy-api", ok: true, url: "https://x.workers.dev", versionId: "v9" })).toBe(
      "pithy-api: deployed. https://x.workers.dev v9",
    );
  });

  test("a success with no scraped details is still a clean deployed line", () => {
    expect(summarizeDeploy({ name: "pithy-api", ok: true })).toBe("pithy-api: deployed.");
  });

  test("a failure line names the worker and the reason", () => {
    expect(summarizeDeploy({ name: "pithy-api", ok: false, error: "exit 1" })).toBe("pithy-api: failed. exit 1");
  });
});

describe("pendingWarning", () => {
  test("warns and pluralizes when migrations are unapplied", () => {
    expect(pendingWarning(2, "production")).toBe(
      "2 migrations unapplied for production. Deploy does not migrate — run pithy migrate --env production.",
    );
    expect(pendingWarning(1, "staging")).toMatch(/^1 migration unapplied/);
  });

  test("is silent when nothing is pending or the count is unknown", () => {
    expect(pendingWarning(0, "production")).toBeUndefined();
    expect(pendingWarning(undefined, "production")).toBeUndefined();
  });
});
