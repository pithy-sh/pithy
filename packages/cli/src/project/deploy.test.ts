// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { narrate, type ProgressEvent } from "../terminal/progress";
import {
  deployOutput,
  deployProject,
  deploySeverity,
  deployVerificationFailed,
  pendingWarning,
  summarizeDeploy,
  uiBuildEnvironment,
} from "./deploy";

/** Representative `wrangler deploy` output — the lines deploy scrapes for the version id and url. */
function wranglerOutput(name: string, version: string): string {
  return [
    `Total Upload: 42.00 KiB / gzip: 12.00 KiB`,
    `Deployed ${name} triggers (0.50 sec)`,
    `  https://${name}.acme.workers.dev`,
    `Current Version ID: ${version}`,
  ].join("\n");
}

/**
 * A stand-in for `vite build` through `@cloudflare/vite-plugin`, faithful to the three behaviors #579
 * turns on — measured against the plugin at 1.54.7 and wrangler at 4.125.0, not assumed:
 *
 * 1. the wrangler environment is selected from **`CLOUDFLARE_ENV`**, never from `ENVIRONMENT`;
 * 2. the config it reads is `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` when that is set, else the Worker's own;
 * 3. it writes a **flattened** config — no `env` section — and a `.wrangler/deploy/config.json` pointing
 *    at it, which is what a following `wrangler deploy` reads instead of the source.
 *
 * The kit has no `@cloudflare/vite-plugin` dependency, so this is how the end-to-end shape is exercised
 * without one. Its value is that it fails the way the real thing failed: unset `CLOUDFLARE_ENV` and it
 * emits the dev stanza.
 */
const VITE_BUILD_STANDIN = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.cwd();
const source = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH ?? join(dir, "wrangler.jsonc");
const config = JSON.parse(readFileSync(source, "utf8"));
const selected = process.env.CLOUDFLARE_ENV;
const stanza = selected === undefined ? undefined : (config.env ?? {})[selected] ?? {};
const flattened = {
  name: stanza === undefined ? config.name : (stanza.name ?? config.name + "-" + selected),
  vars: stanza === undefined ? config.vars : (stanza.vars ?? {}),
  assets: { directory: "./dist/client" },
  ...(selected === undefined ? {} : { targetEnvironment: selected }),
};
mkdirSync(join(dir, "dist", "worker"), { recursive: true });
writeFileSync(join(dir, "dist", "worker", "wrangler.json"), JSON.stringify(flattened));
mkdirSync(join(dir, ".wrangler", "deploy"), { recursive: true });
writeFileSync(
  join(dir, ".wrangler", "deploy", "config.json"),
  JSON.stringify({ configPath: "../../dist/worker/wrangler.json", auxiliaryWorkers: [] }),
);
`;

/**
 * **Take `CLOUDFLARE_ENV` out of the shell for the cases below, and put it back after.**
 *
 * The variable selects a wrangler stanza — `args.env ?? CLOUDFLARE_ENV` — so it is an input to what
 * `deployProject` publishes, read by the stand-in build and by the gate. A developer who exports one for
 * other work would otherwise be running a different test than CI is: a bare deploy would be held to
 * `env.prod` and refuse, correctly, in a case about something else entirely.
 *
 * Every case that means something by the variable states it, through `processEnv`. This is what makes
 * that statement complete rather than an overlay on whatever was already there.
 */
function statesItsOwnEnvironment(): void {
  let exported: string | undefined;
  beforeEach(() => {
    exported = process.env.CLOUDFLARE_ENV;
    delete process.env.CLOUDFLARE_ENV;
  });
  afterEach(() => {
    if (exported === undefined) delete process.env.CLOUDFLARE_ENV;
    else process.env.CLOUDFLARE_ENV = exported;
  });
}

describe("deployProject", () => {
  let dir: string;
  statesItsOwnEnvironment();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-deploy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Create `apps/<dir>/wrangler.jsonc` — the only shape a Worker has; there is no root Worker. */
  async function writeWorker(dirName: string, name: string, rest: Record<string, unknown> = {}): Promise<void> {
    const at = join(dir, "apps", dirName);
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name, ...rest }));
  }

  /** The `env.<name>` stanzas a scaffolded Worker carries: its own script name and its own vars. */
  function stanzas(name: string, ...environments: string[]): Record<string, unknown> {
    return {
      vars: { ENVIRONMENT: "dev" },
      env: Object.fromEntries(
        environments.map((environment) => [
          environment,
          { name: `${name}-${environment}`, vars: { ENVIRONMENT: environment } },
        ]),
      ),
    };
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
      account: null,
      projectDir: dir,
      env: "prod",
      runDeploy: async (target, args) => {
        calls.push({ name: target.name, args });
        return wranglerOutput(target.name, `ver-${target.name}`);
      },
    });

    expect(calls).toEqual([
      { name: "pithy-api", args: ["deploy", "--env", "prod", "--experimental-provision=false"] },
      { name: "pithy-web", args: ["deploy", "--env", "prod", "--experimental-provision=false"] },
    ]);
    expect(results).toEqual([
      { name: "pithy-api", ok: true, versionId: "ver-pithy-api", url: "https://pithy-api.acme.workers.dev" },
      { name: "pithy-web", ok: true, versionId: "ver-pithy-web", url: "https://pithy-web.acme.workers.dev" },
    ]);
  });

  /**
   * **`pithy deploy` printed nothing at all until it had finished. For minutes (#578).**
   *
   * The wrangler spawn under each of these is captured on purpose — its output is summarized, not
   * streamed, which is the brand voice — and capturing it removed the only evidence the command was
   * alive. So the loop says what it is on before it starts, and says how it went as it settles: the
   * pair is what an interrupted run is read back from, and the settled line **moves** here out of the
   * command's end-of-run block rather than being printed twice.
   */
  test("says which worker it is on before it starts, and how it went as it settles", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");
    const events: ProgressEvent[] = [];

    await narrate(
      (event) => events.push(event),
      async () => {
        await deployProject({
          account: null,
          projectDir: dir,
          env: "prod",
          runDeploy: async (target) => wranglerOutput(target.name, `ver-${target.name}`),
        });
      },
    );

    expect(events).toEqual([
      { phase: "start", what: "pithy-api" },
      { phase: "settled", line: "pithy-api: deployed. https://pithy-api.acme.workers.dev ver-pithy-api" },
      { phase: "start", what: "pithy-web" },
      { phase: "settled", line: "pithy-web: deployed. https://pithy-web.acme.workers.dev ver-pithy-web" },
    ]);
  });

  /** A failure settles too — the one Worker that broke must not wait behind every one that worked. */
  test("a worker that fails settles as it fails, not after the rest have shipped", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");
    const events: ProgressEvent[] = [];

    await narrate(
      (event) => events.push(event),
      async () => {
        await deployProject({
          account: null,
          projectDir: dir,
          runDeploy: async (target) => {
            if (target.name === "pithy-api")
              throw new InternalError({ message: "wrangler exited 1.", action: "Look." });
            return wranglerOutput(target.name, "v1");
          },
        });
      },
    );

    const settled = events.filter((event) => event.phase === "settled");
    expect(settled[0]).toEqual({
      phase: "settled",
      line: summarizeDeploy({ name: "pithy-api", ok: false, error: "wrangler exited 1." }),
    });
    expect(events.indexOf(settled[0] as ProgressEvent)).toBe(1);
  });

  /** Outside a narrated span — which is every `--json` run — the loop is exactly as quiet as it was. */
  test("narrates nothing when nobody installed a sink", async () => {
    await writeWorker("api", "pithy-api");

    const results = await deployProject({
      account: null,
      projectDir: dir,
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
    });

    expect(results.map((deploy) => deploy.ok)).toEqual([true]);
  });

  test("omits --env when no environment is given (each worker's top-level config)", async () => {
    await writeWorker("app", "pithy-app");
    const calls: string[][] = [];

    await deployProject({
      account: null,
      projectDir: dir,
      runDeploy: async (_target, args) => {
        calls.push(args);
        return wranglerOutput("pithy-app", "v1");
      },
    });

    expect(calls).toEqual([["deploy", "--experimental-provision=false"]]);
  });

  test("records a failed worker, keeps deploying the rest, and reports the failure", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");

    const results = await deployProject({
      account: null,
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
      account: null,
      projectDir: dir,
      env: "prod",
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
      account: null,
      projectDir: dir,
      runDeploy: async () => "Deployed. No parseable details here.",
    });

    expect(results).toEqual([{ name: "pithy-app", ok: true }]);
  });

  test("fails when the project has no deployable workers", async () => {
    const failure = await deployProject({ account: null, projectDir: dir, runDeploy: async () => "" }).catch(
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
      account: null,
      projectDir: dir,
      env: "prod",
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
      account: null,
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
    await writeWorker("web", "pithy-web", stanzas("pithy-web", "prod"));
    await writeUi("web");
    const seen: Record<string, string>[] = [];

    await deployProject({
      account: null,
      projectDir: dir,
      env: "prod",
      runBuild: async (_target, _command, _args, buildEnv) => void seen.push({ ...buildEnv }),
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
    });
    expect(seen).toEqual([{ ENVIRONMENT: "prod", CLOUDFLARE_ENV: "prod" }]);
  });

  test("a bare deploy passes no environment, so the build resolves the plugin's own default", async () => {
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    const seen: Record<string, string>[] = [];

    await deployProject({
      account: null,
      projectDir: dir,
      runBuild: async (_target, _command, _args, buildEnv) => void seen.push({ ...buildEnv }),
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
    });
    expect(seen).toEqual([{}]);
  });

  test("a worker with no ui block never builds", async () => {
    await writeWorker("api", "pithy-api");
    let builds = 0;

    const results = await deployProject({
      account: null,
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
      account: null,
      projectDir: dir,
      env: "prod",
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
      account: null,
      projectDir: dir,
      env: "staging",
      runBuild: async () => {},
      runDeploy: async (_target, args) => {
        calls.push(args);
        return wranglerOutput("pithy-web", "v1");
      },
    });

    // vite build writes .wrangler/deploy/config.json, which redirects the plain deploy — no -c, no new flag.
    expect(calls).toEqual([["deploy", "--env", "staging", "--experimental-provision=false"]]);
  });

  test("audits a failed build as a failed deploy of that worker, tagged with the stage", async () => {
    await writeWorker("web", "pithy-web");
    await writeUi("web");
    const events: CliAuditEvent[] = [];

    await deployProject({
      account: null,
      projectDir: dir,
      env: "prod",
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
      account: null,
      projectDir: dir,
      env: "prod",
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "deploy/worker_deployed",
      outcome: "success",
      severity: "warning",
      resourceType: "cf_worker",
      // The Worker deployed is `resourceId` — the thing acted on. Its origin (project, environment,
      // worker) is stamped on the row by the recorder, so neither is duplicated into `metadata`.
      resourceId: "pithy-api",
      metadata: { versionId: "v1" },
    });
  });

  test("audits a failed deploy as a failure, and staging stays info severity", async () => {
    await writeWorker("api", "pithy-api");
    const events: CliAuditEvent[] = [];

    await deployProject({
      account: null,
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

/**
 * **A deploy cannot publish a configuration that is not the requested environment's (#579).**
 *
 * `pithy deploy --env staging` shipped a Worker composed as `dev`, publicly, and said `deployed.`. The
 * build was handed `ENVIRONMENT`, which `@cloudflare/vite-plugin` does not read to select a wrangler
 * environment, so it emitted the top-level stanza; the `.wrangler/deploy/config.json` it writes then
 * redirected `wrangler deploy` to that flattened output, where `--env staging` matched nothing.
 *
 * These drive the real mechanism rather than a stub of it. {@link VITE_BUILD_STANDIN} is a build that
 * behaves the way the plugin measurably does — it selects the stanza from `CLOUDFLARE_ENV`, reads the
 * config `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` names, flattens it, and writes the redirect — so
 * removing `CLOUDFLARE_ENV` from `uiBuildEnvironment` makes it emit the dev stanza again, and the gate
 * below is what has to notice.
 */
describe("deployProject refuses a configuration that is not the requested environment's", () => {
  let dir: string;
  let standin: string;
  statesItsOwnEnvironment();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-deploy-env-"));
    standin = join(dir, "vite-build-standin.mjs");
    await writeFile(standin, VITE_BUILD_STANDIN);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const runProcess = promisify(execFile);

  /** Write one Worker with a front end and the `env.<name>` stanzas a scaffolded project carries. */
  async function writeUiWorker(name: string, ...environments: string[]): Promise<string> {
    const at = join(dir, "apps", "web");
    await mkdir(at, { recursive: true });
    await writeFile(
      join(at, "wrangler.jsonc"),
      JSON.stringify({
        name,
        vars: { ENVIRONMENT: "dev" },
        env: Object.fromEntries(
          environments.map((environment) => [
            environment,
            { name: `${name}-${environment}`, vars: { ENVIRONMENT: environment } },
          ]),
        ),
      }),
    );
    await writeFile(
      join(at, "pithy.worker.jsonc"),
      JSON.stringify({ ui: { stub: "react", build: ["vite", "build"] } }),
    );
    return at;
  }

  /** Run the stand-in build with exactly the environment `deployProject` decided on — nothing else. */
  const runStandin = (): Parameters<typeof deployProject>[0]["runBuild"] => async (target, _c, _a, buildEnv) => {
    await runProcess(process.execPath, [standin], { cwd: target.dir, env: { ...process.env, ...buildEnv } });
  };

  test("a build for the requested environment deploys, and ships that environment's stanza", async () => {
    const at = await writeUiWorker("acme-web", "staging");
    const argv: string[][] = [];

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "staging",
      runBuild: runStandin(),
      runDeploy: async (_target, args) => {
        argv.push(args);
        return wranglerOutput("acme-web-staging", "v1");
      },
    });

    expect(results[0]).toMatchObject({ name: "acme-web", ok: true, built: true });
    expect(argv).toEqual([["deploy", "--env", "staging", "--experimental-provision=false"]]);
    // The acceptance criterion, read off disk: the built config is staging's, not the top level's.
    const built = JSON.parse(await readFile(join(at, "dist", "worker", "wrangler.json"), "utf8")) as {
      name: string;
      vars: { ENVIRONMENT: string };
    };
    expect(built.name).toBe("acme-web-staging");
    expect(built.vars.ENVIRONMENT).toBe("staging");
  });

  test("a build that emitted the top-level stanza refuses before the upload, naming the file", async () => {
    // The planted failure, in the shape it actually arrived in: the build ran without `CLOUDFLARE_ENV`,
    // so `dist/worker/wrangler.json` is the dev stanza and the redirect points wrangler at it.
    const at = await writeUiWorker("acme-web", "staging");
    let uploaded = 0;

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "staging",
      runBuild: async (target) => {
        await runProcess(process.execPath, [standin], { cwd: target.dir, env: { ...process.env } });
      },
      runDeploy: async (target) => {
        uploaded += 1;
        return wranglerOutput(target.name, "v1");
      },
    });

    expect(uploaded).toBe(0);
    expect(results[0]).toMatchObject({ name: "acme-web", ok: false, built: true });
    expect(results[0]?.error).toContain(join(at, "dist", "worker", "wrangler.json"));
    expect(results[0]?.error).toContain("acme-web-staging");
  });

  test("the refusal is audited as a failure of the config step, not of the build or the upload", async () => {
    await writeUiWorker("acme-web", "staging");
    const events: CliAuditEvent[] = [];

    await deployProject({
      account: null,
      projectDir: dir,
      env: "staging",
      runBuild: async (target) => {
        await runProcess(process.execPath, [standin], { cwd: target.dir, env: { ...process.env } });
      },
      runDeploy: async (target) => wranglerOutput(target.name, "v1"),
      audit: async (event) => void events.push(event),
    });

    expect(events[0]).toMatchObject({ outcome: "failure", metadata: { stage: "config" } });
  });

  test("a bare deploy still ships each Worker's top-level stanza", async () => {
    const at = await writeUiWorker("acme-web", "staging");
    const argv: string[][] = [];

    const results = await deployProject({
      account: null,
      projectDir: dir,
      runBuild: runStandin(),
      runDeploy: async (_target, args) => {
        argv.push(args);
        return wranglerOutput("acme-web", "v1");
      },
    });

    expect(results[0]).toMatchObject({ ok: true });
    expect(argv).toEqual([["deploy", "--experimental-provision=false"]]);
    const built = JSON.parse(await readFile(join(at, "dist", "worker", "wrangler.json"), "utf8")) as { name: string };
    expect(built.name).toBe("acme-web");
  });

  test("refuses a bare deploy an exported CLOUDFLARE_ENV would publish as another environment", async () => {
    // **The hole this gate shipped with, end to end.** No front end, so no build, no redirect, and the
    // Worker's own `wrangler.jsonc` is what wrangler reads — everything the gate looked at agrees. The
    // only thing that moved the stanza is the shell, and wrangler resolves `args.env ?? CLOUDFLARE_ENV`,
    // so a bare `pithy deploy` here publishes `acme-api-prod` while an argv-only reading approves it.
    const at = join(dir, "apps", "api");
    await mkdir(at, { recursive: true });
    await writeFile(
      join(at, "wrangler.jsonc"),
      JSON.stringify({
        name: "acme-api",
        vars: { ENVIRONMENT: "dev" },
        env: { prod: { name: "acme-api-prod", vars: { ENVIRONMENT: "prod" } } },
      }),
    );
    let uploaded = 0;

    const results = await deployProject({
      account: null,
      projectDir: dir,
      processEnv: { CLOUDFLARE_ENV: "prod" },
      runDeploy: async (target) => {
        uploaded += 1;
        return wranglerOutput(target.name, "v1");
      },
    });

    expect(uploaded).toBe(0);
    expect(results[0]).toMatchObject({ name: "acme-api", ok: false });
    expect(results[0]?.error).toContain("acme-api-prod");
  });

  test("a Worker with no front end writes no redirect, so nothing about it changes", async () => {
    const at = join(dir, "apps", "api");
    await mkdir(at, { recursive: true });
    await writeFile(
      join(at, "wrangler.jsonc"),
      JSON.stringify({ name: "acme-api", env: { staging: { name: "acme-api-staging" } } }),
    );
    const argv: string[][] = [];

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "staging",
      runDeploy: async (_target, args) => {
        argv.push(args);
        return wranglerOutput("acme-api-staging", "v1");
      },
    });

    expect(results[0]).toMatchObject({ ok: true });
    expect(argv).toEqual([["deploy", "--env", "staging", "--experimental-provision=false"]]);
  });

  test("a feature environment builds against its generated config and stops passing --config", async () => {
    // The other half of #579, failing in the opposite direction: `--config` beats the redirect, and the
    // source config has no `assets.directory`, so a UI Worker's feature deploy failed on it every time.
    // The generated config reaches the build instead, which is where the asset wiring is written.
    const at = await writeUiWorker("acme-web", "staging");
    await mkdir(join(at, ".wrangler", "pithy"), { recursive: true });
    await writeFile(
      join(at, ".wrangler", "pithy", "wrangler.feature.jsonc"),
      JSON.stringify({
        name: "acme-web",
        vars: { ENVIRONMENT: "dev" },
        env: { feature: { name: "acme-web-pr-7", vars: { ENVIRONMENT: "feature" } } },
      }),
    );
    const argv: string[][] = [];

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "feature",
      runBuild: runStandin(),
      runDeploy: async (_target, args) => {
        argv.push(args);
        return wranglerOutput("acme-web-pr-7", "v1");
      },
    });

    expect(results[0]).toMatchObject({ ok: true, built: true });
    expect(argv).toEqual([["deploy", "--env", "feature", "--experimental-provision=false"]]);
    const built = JSON.parse(await readFile(join(at, "dist", "worker", "wrangler.json"), "utf8")) as { name: string };
    expect(built.name).toBe("acme-web-pr-7");
  });

  test("a feature deploy of a Worker with no front end still gets --config", async () => {
    const at = join(dir, "apps", "api");
    await mkdir(join(at, ".wrangler", "pithy"), { recursive: true });
    await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name: "acme-api" }));
    await writeFile(
      join(at, ".wrangler", "pithy", "wrangler.feature.jsonc"),
      JSON.stringify({ name: "acme-api", env: { feature: { name: "acme-api-pr-7" } } }),
    );
    const argv: string[][] = [];

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "feature",
      runDeploy: async (_target, args) => {
        argv.push(args);
        return wranglerOutput("acme-api-pr-7", "v1");
      },
    });

    expect(results[0]).toMatchObject({ ok: true });
    expect(argv).toEqual([
      [
        "deploy",
        "--env",
        "feature",
        "--experimental-provision=false",
        "--config",
        join(at, ".wrangler", "pithy", "wrangler.feature.jsonc"),
      ],
    ]);
  });
});

/**
 * **`pithy deploy --env feature` verifies what it just deployed (#643).** A feature's stanza lives in the
 * generated config, never in the tracked `wrangler.jsonc`, so a verification that read the tracked file found
 * no stanza, no address, and never probed. It reads the generated config the way `readAddressStanza` does.
 */
describe("a feature deploy's verification", () => {
  let dir: string;
  statesItsOwnEnvironment();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-deploy-verify-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const SCRIPT = "replay-f643-feature-address--board";
  const ORIGIN = `https://${SCRIPT}.acme.workers.dev`;

  /** Worker `board`: a tracked config with no feature stanza, and the generated one provisioning wrote. */
  async function provisioned(top: Record<string, unknown> = {}): Promise<void> {
    const at = join(dir, "apps", "board");
    await mkdir(join(at, ".wrangler", "pithy"), { recursive: true });
    await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name: "replay-board", ...top }));
    await writeFile(
      join(at, ".wrangler", "pithy", "wrangler.feature.jsonc"),
      JSON.stringify({
        name: "replay-board",
        ...top,
        env: { feature: { name: SCRIPT, vars: { ENVIRONMENT: "feature", BASE_URL: ORIGIN } } },
      }),
    );
  }

  test("probes the feature's own workers.dev origin for the version just shipped", async () => {
    await provisioned();
    const probed: { url: string; expectedVersion: string }[] = [];

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "feature",
      runDeploy: async () => wranglerOutput(SCRIPT, "v1"),
      verifyDeploy: async (probe) => {
        probed.push(probe);
        return { status: "verified", observed: ["v1"], attempts: 1, detail: "served v1" };
      },
    });

    expect(probed).toEqual([{ url: ORIGIN, expectedVersion: "v1" }]);
    expect(results[0]).toMatchObject({ ok: true, verification: "verified" });
  });

  test("a feature with no workers.dev address, by an inherited workers_dev: false, is not probed", async () => {
    await provisioned({ workers_dev: false });
    const probed: string[] = [];

    await deployProject({
      account: null,
      projectDir: dir,
      env: "feature",
      runDeploy: async () => wranglerOutput(SCRIPT, "v1"),
      verifyDeploy: async (probe) => {
        probed.push(probe.url);
        return { status: "verified", observed: ["v1"], attempts: 1, detail: "served v1" };
      },
    });

    expect(probed).toEqual([]);
  });
});

describe("uiBuildEnvironment", () => {
  test("names the wrangler stanza as well as the runtime environment — two variables, two jobs", () => {
    expect(uiBuildEnvironment("staging", "/p/apps/web")).toEqual({ ENVIRONMENT: "staging", CLOUDFLARE_ENV: "staging" });
  });

  test("a bare deploy says nothing, so the build resolves the plugin's own defaults", () => {
    expect(uiBuildEnvironment(undefined, "/p/apps/web")).toEqual({});
  });

  test("dev is the top-level stanza, so it names no wrangler environment", () => {
    // `DeclaredEnvironments` refuses `dev`, so there is no `env.dev` for `CLOUDFLARE_ENV` to select —
    // asking for one would fail the build on a config that is correct.
    expect(uiBuildEnvironment("dev", "/p/apps/web")).toEqual({ ENVIRONMENT: "dev" });
  });

  test("a feature environment points the build at the generated config its ids live in", () => {
    expect(uiBuildEnvironment("feature", join("/p", "apps", "web"))).toEqual({
      ENVIRONMENT: "feature",
      CLOUDFLARE_ENV: "feature",
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: join("/p", "apps", "web", ".wrangler", "pithy", "wrangler.feature.jsonc"),
    });
  });
});

describe("deploySeverity", () => {
  test("only production is warning; staging, dev, and the top-level worker are info", () => {
    expect(deploySeverity("prod")).toBe("warning");
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

  /**
   * The color and the exit code read the same rule, so the line an adopter sees cannot say "routine" over
   * a verification that fails the command (#264).
   */
  test("a verification that fails the command is reported as a failure line", () => {
    const unreachable = summarizeDeploy({
      name: "pithy-api",
      ok: true,
      versionId: "v9",
      verification: "unreachable",
      verificationDetail: "Nothing answered at https://api.example.com in 5 attempts.",
    });
    expect(unreachable).toContain("Nothing answered at https://api.example.com");
    expect(deployVerificationFailed([{ name: "pithy-api", ok: true, verification: "unreachable" }])).toBe(true);
    expect(deployVerificationFailed([{ name: "pithy-api", ok: true, verification: "inconclusive" }])).toBe(false);
  });

  /**
   * #579: `dash-board: deployed.` with the probe's finding indented underneath it is how a Worker
   * composed as `dev` was reported live on a public URL. The upload happened and the line still says so;
   * what it must not say is that the deploy was fine.
   */
  test("a probe that could not reach the declared origin is not a success line", () => {
    const line = summarizeDeploy({
      name: "pithy-api",
      ok: true,
      versionId: "v9",
      url: "https://x.workers.dev",
      verification: "unreachable",
      verificationDetail: "Nothing answered at https://api.example.com in 5 attempts.",
    });
    const [headline] = line.split("\n");
    expect(headline).toContain("deployed, and not verified.");
    expect(headline).toContain("https://x.workers.dev v9");
    expect(line).not.toMatch(/^[^\n]*: deployed\. /);
  });

  test("a verification that does not fail the command keeps its success line and its note", () => {
    const line = summarizeDeploy({
      name: "pithy-api",
      ok: true,
      versionId: "v9",
      verification: "inconclusive",
      verificationDetail: "https://api.example.com is serving 2 versions — a gradual deployment is in progress.",
    });
    expect(line.split("\n")[0]).toBe("pithy-api: deployed. v9");
  });
});

describe("pendingWarning", () => {
  test("warns and pluralizes when migrations are unapplied", () => {
    expect(pendingWarning(2, "prod")).toBe(
      "2 migrations unapplied for prod. Deploy does not migrate — run pithy migrate --env prod.",
    );
    expect(pendingWarning(1, "staging")).toMatch(/^1 migration unapplied/);
  });

  test("is silent when nothing is pending or the count is unknown", () => {
    expect(pendingWarning(0, "prod")).toBeUndefined();
    expect(pendingWarning(undefined, "prod")).toBeUndefined();
  });
});

/**
 * The scrape of wrangler's own output — `#612`.
 *
 * A deploy reported `https://staging.app.pithy.sh")` as the address a Worker had been deployed to,
 * because `\S+` runs to the next space and wrangler had wrapped the address in a quote and a bracket.
 * An address that reaches nothing when copied is worse than no address at all: the line is read as a
 * fact and the punctuation is invisible at a glance.
 */
describe("what a deploy reports, scraped out of wrangler's prose", () => {
  const parse = deployOutput.parse;

  test("an address wrapped by the sentence around it comes back as an address", () => {
    // The shape that produced the report, quoted inside a bracket.
    expect(parse('Deployed dash-board ("https://staging.app.pithy.sh")\nVersion ID: 7908726e').url).toBe(
      "https://staging.app.pithy.sh",
    );
    expect(parse("  https://dash-board.pithy.workers.dev\n").url).toBe("https://dash-board.pithy.workers.dev");
    expect(parse('Uploaded to "https://acme.example.com"').url).toBe("https://acme.example.com");
    expect(parse("Deployed to (https://acme.example.com).").url).toBe("https://acme.example.com");
    expect(parse("Live at https://acme.example.com, version 3.").url).toBe("https://acme.example.com");
  });

  test("a bracket the address itself opened is part of the address", () => {
    // Legal, rare, and somebody's real path. The trailing bracket is dropped only when the token
    // holds no opener to match it.
    expect(parse("https://example.com/wiki/Thing_(disambiguation)").url).toBe(
      "https://example.com/wiki/Thing_(disambiguation)",
    );
    expect(parse('("https://example.com/wiki/Thing_(disambiguation)")').url).toBe(
      "https://example.com/wiki/Thing_(disambiguation)",
    );
  });

  test("the version id is trimmed the same way, for the same reason", () => {
    expect(parse("Version ID: 7908726e-a1a8-4111-8e56-4d34d23fab45").versionId).toBe(
      "7908726e-a1a8-4111-8e56-4d34d23fab45",
    );
    expect(parse('Version ID: "7908726e".').versionId).toBe("7908726e");
  });

  test("finding nothing is an ordinary answer, not a failure", () => {
    expect(parse("Total Upload: 512 KiB\n")).toEqual({});
  });

  test("the last address is the deployed one, not an earlier link", () => {
    const stdout = [
      "See https://developers.cloudflare.com/workers for help.",
      "Deployed to https://acme.example.com",
    ].join("\n");
    expect(parse(stdout).url).toBe("https://acme.example.com");
  });
});
