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

  /** Give a worker a front end: the `ui` block `pithy ui add` writes into its `pithy.worker.jsonc`. */
  async function writeUi(dirName: string, build: string[] = ["vite", "build"]): Promise<void> {
    const at = join(dir, "apps", dirName);
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "pithy.worker.jsonc"), JSON.stringify({ ui: { stub: "react", build } }));
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

  test("a worker with a ui block builds first, in its own dir, then deploys", async () => {
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    const order: string[] = [];
    const builds: { command: string; args: string[]; cwd: string }[] = [];

    const results = await deployProject({
      projectDir: dir,
      env: "production",
      runBuild: async (target, command, args) => {
        order.push(`build:${target.name}`);
        builds.push({ command, args, cwd: target.dir });
      },
      runDeploy: async (target) => {
        order.push(`deploy:${target.name}`);
        return wranglerOutput(target.name, "v1");
      },
    });

    expect(order).toEqual(["build:pithy-web", "deploy:pithy-web"]);
    // No lockfile in the temp project, so the adopter's manager resolves to npm — never a hardcoded npx call.
    expect(builds).toEqual([{ command: "npx", args: ["vite", "build"], cwd: join(dir, "apps", "web") }]);
    expect(results[0]).toMatchObject({ name: "pithy-web", ok: true, built: true, versionId: "v1" });
  });

  test("the build runs through the project's own package manager, not a hardcoded npx", async () => {
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    await writeFile(join(dir, "bun.lock"), "");
    const builds: { command: string; args: string[] }[] = [];

    await deployProject({
      projectDir: dir,
      runBuild: async (_target, command, args) => void builds.push({ command, args }),
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
    });

    expect(builds).toEqual([{ command: "bun", args: ["x", "vite", "build"] }]);
  });

  test("--env reaches the UI build — the projection it inlines is the deployed environment's", async () => {
    // Regression. `@pithy-sh/vite` resolves each capability's client-safe projection for a NAMED
    // environment at build time and falls back to `dev`. A build that does not carry the deploy's
    // `--env` therefore inlines dev values into a production bundle — for Turnstile, Cloudflare's
    // always-passes test sitekey. It is silent, and it defeats the gate.
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    const environments: (string | undefined)[] = [];

    await deployProject({
      projectDir: dir,
      env: "production",
      runBuild: async (_target, _command, _args, environment) => void environments.push(environment),
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
    });
    expect(environments).toEqual(["production"]);
  });

  test("a bare deploy passes no environment, so the build resolves the plugin's own default", async () => {
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    const environments: (string | undefined)[] = [];

    await deployProject({
      projectDir: dir,
      runBuild: async (_target, _command, _args, environment) => void environments.push(environment),
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
    });
    expect(environments).toEqual([undefined]);
  });

  test("a worker with no ui block never builds", async () => {
    await writeWorker("api", "pithy-api");
    let builds = 0;

    const results = await deployProject({
      projectDir: dir,
      runBuild: async () => void builds++,
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
    });

    expect(builds).toBe(0);
    // The field is absent, not false: there was nothing to build.
    expect(results).toEqual([
      { name: "pithy-api", ok: true, versionId: "v1", url: "https://pithy-api.acme.workers.dev" },
    ]);
  });

  test("a failed build fails that worker, skips its deploy, and the next worker still ships", async () => {
    await writeWorker("api", "pithy-api");
    await writeUi("api");
    await writeWorker("web", "pithy-web");
    const deployed: string[] = [];

    const results = await deployProject({
      projectDir: dir,
      env: "production",
      runBuild: async () => {
        throw new InternalError({ message: "npx vite build failed.", detail: "exit 1\nCould not resolve ./client" });
      },
      runDeploy: async (target) => {
        deployed.push(target.name);
        return wranglerOutput(target.name, "v3");
      },
    });

    // Shipping a Worker whose assets never built is worse than not shipping it.
    expect(deployed).toEqual(["pithy-web"]);
    expect(results[0]).toMatchObject({ name: "pithy-api", ok: false, built: false });
    expect(results[0]?.error).toMatch(/Could not resolve/);
    expect(results[1]).toMatchObject({ name: "pithy-web", ok: true });
  });

  test("--env threads to deploy unchanged when a worker builds first", async () => {
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    const calls: string[][] = [];

    await deployProject({
      projectDir: dir,
      env: "staging",
      runBuild: async () => {},
      runDeploy: async (_target, args) => {
        calls.push(args);
        return wranglerOutput("pithy-web", "v1");
      },
    });

    // vite build writes .wrangler/deploy/config.json, which redirects the plain deploy — no -c, no new flag.
    expect(calls).toEqual([["deploy", "--env", "staging"]]);
  });

  test("audits a failed build as a failed deploy of that worker, tagged with the stage", async () => {
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    const events: CliAuditEvent[] = [];

    await deployProject({
      projectDir: dir,
      env: "production",
      runBuild: async () => {
        throw new Error("build failed");
      },
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "failure", severity: "warning", metadata: { stage: "build" } });
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

  test("a failed build reads as a build failure — a different problem with a different fix", () => {
    expect(summarizeDeploy({ name: "pithy-web", ok: false, built: false, error: "exit 1" })).toBe(
      "pithy-web: build failed. exit 1",
    );
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
