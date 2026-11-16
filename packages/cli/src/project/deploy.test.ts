// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { EXIT, exitCodeOf } from "../terminal/exitClass";
import { formatJsonLine } from "../terminal/output";
import { narrate, type ProgressEvent } from "../terminal/progress";
import { snapshotTree } from "../test-utils/treeSnapshot";
import {
  deployFailureExit,
  deployOutput,
  deployProject,
  deploySeverity,
  deployVerificationFailed,
  pendingWarning,
  summarizeDeploy,
  summarizePlannedDeploy,
  uiBuildEnvironment,
} from "./deploy";
import { NO_PROVISION_ARG } from "./effectiveConfig";
import { runWrangler, WranglerCredentialsError } from "./wrangler";

/** The marker an upload carries, after the deploy's own switches, until the deploy has finished. */
const STAMPED = ["--var", "PITHY_DEPLOY_STAMP:unfinished"];

/** Whether an argv is the bundle pass, `wrangler deploy --dry-run --outdir`, rather than the upload. */
const bundling = (args: readonly string[]): boolean => args.includes("--outdir");

/** The outcome every row reaches when no stamp reader was given. */
const UNREAD = {
  outcome: "deployed",
  reason: "Its deploy stamp could not be read. No Cloudflare client was available to read it.",
} as const;

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
 * Wrangler's telemetry notice, verbatim, as `wrangler deploy` prints it after the deploy summary.
 *
 * It is gated on `metricsConfig.permission.enabled && permission.bannerLastShown !== wranglerVersion`
 * (wrangler 4.125.0, `cli.js:179249-179258`), so it appears once per wrangler version per machine and
 * only where telemetry is on, so a scrape that took it for an address would fail only on occasion.
 */
const TELEMETRY_NOTICE =
  "\nCloudflare collects anonymous telemetry about your usage of Wrangler. Learn more at https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md";

/**
 * A staging deploy with one custom domain, `workers_dev: false`, and the telemetry notice as the only
 * `https://` anywhere in the capture.
 *
 * Every line is quoted from the printers in wrangler 4.125.0 — `Total Upload:` (`cli.js:143316`),
 * `Worker Startup Time:` (`cli.js:150645`), the triggers block and its two-space-indented target
 * (`cli.js:142868-142871`), `renderRoute`'s custom-domain suffix (`cli.js:141870-141871`) and
 * `Current Version ID:` (`cli.js:143479`). The version is named so the next wrangler rewording is traceable.
 */
function wranglerOutputWithTelemetryNotice(): string {
  return [
    "Total Upload: 1234.56 KiB / gzip: 234.56 KiB",
    "Worker Startup Time: 14 ms",
    "Deployed dash-board triggers (3.42 sec)",
    "  staging.app.pithy.sh (custom domain - zone name: pithy.sh)",
    "Current Version ID: 0a4402fb-d36e-408d-b461-c6502ee34c16",
    TELEMETRY_NOTICE,
  ].join("\n");
}

/**
 * A stand-in for `vite build` through `@cloudflare/vite-plugin`, faithful to the three behaviors the
 * environment gate turns on — measured against the plugin at 1.54.7 and wrangler at 4.125.0, not assumed:
 *
 * 1. the wrangler environment is selected from **`CLOUDFLARE_ENV`**, never from `ENVIRONMENT`;
 * 2. the config it reads is `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` when that is set, else the Worker's own;
 * 3. it writes a **flattened** config — no `env` section — and a `.wrangler/deploy/config.json` pointing
 *    at it, which is what a following `wrangler deploy` reads instead of the source.
 *
 * The kit has no `@cloudflare/vite-plugin` dependency, so this is how the end-to-end shape is exercised
 * without one. Its value is that it fails the way the real plugin does: unset `CLOUDFLARE_ENV` and it
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
        if (!bundling(args)) calls.push({ name: target.name, args });
        return wranglerOutput(target.name, `ver-${target.name}`);
      },
    });

    expect(calls).toEqual([
      { name: "pithy-api", args: ["deploy", "--env", "prod", "--experimental-provision=false", ...STAMPED] },
      { name: "pithy-web", args: ["deploy", "--env", "prod", "--experimental-provision=false", ...STAMPED] },
    ]);
    expect(results).toEqual([
      {
        name: "pithy-api",
        ok: true,
        ...UNREAD,
        versionId: "ver-pithy-api",
        url: "https://pithy-api.acme.workers.dev",
      },
      {
        name: "pithy-web",
        ok: true,
        ...UNREAD,
        versionId: "ver-pithy-web",
        url: "https://pithy-web.acme.workers.dev",
      },
    ]);
  });

  test("carries the privacy attestation into every Worker as one --var, after the deploy's own switches", async () => {
    await writeWorker("api", "pithy-api");
    const calls: string[][] = [];
    const privacy = {
      classes: ["pii"],
      consoleGate: "enforced" as const,
      reason: null,
      attestedAt: "2026-10-20T12:00:00.000Z",
    };
    await deployProject({
      account: null,
      projectDir: dir,
      env: "prod",
      privacy,
      runDeploy: async (target, args) => {
        if (!bundling(args)) calls.push(args);
        return wranglerOutput(target.name, "ver-1");
      },
    });
    expect(calls).toEqual([
      [
        "deploy",
        "--env",
        "prod",
        "--experimental-provision=false",
        "--var",
        `PITHY_PRIVACY:${JSON.stringify(privacy)}`,
        ...STAMPED,
      ],
    ]);
  });

  /**
   * **A binding's target ships before the Worker that binds it.** Cloudflare refuses an upload whose
   * service binding names a script that does not exist yet, so on a first deploy the order is the difference
   * between a project that ships and one that fails on its first Worker.
   */
  test("deploys a service binding's target before the Worker that binds it", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");
    await writeFile(
      join(dir, "apps", "api", "pithy.config.ts"),
      'const app = { name: "api", requiredBindings: [{ type: "service", name: "WEB", service: "web" }] };\nexport default { capabilities: [], app };\n',
    );
    const order: string[] = [];
    await deployProject({
      account: null,
      projectDir: dir,
      env: "prod",
      runDeploy: async (target, args) => {
        if (!bundling(args)) order.push(target.name);
        return wranglerOutput(target.name, "v1");
      },
    });
    expect(order).toEqual(["pithy-web", "pithy-api"]);
  });

  test("a target named by its deploy name ships first too", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");
    await writeFile(
      join(dir, "apps", "api", "pithy.config.ts"),
      'const app = { name: "api", requiredBindings: [{ type: "service", name: "WEB", service: "pithy-web" }] };\nexport default { capabilities: [], app };\n',
    );
    const order: string[] = [];
    await deployProject({
      account: null,
      projectDir: dir,
      env: "prod",
      runDeploy: async (target, args) => {
        if (!bundling(args)) order.push(target.name);
        return wranglerOutput(target.name, "v1");
      },
    });
    expect(order).toEqual(["pithy-web", "pithy-api"]);
  });

  /**
   * **Each Worker is narrated as it runs.** The wrangler spawn under each is captured on purpose — its output
   * is summarized, not streamed — so the loop says what it is on before it starts, and how it went as it
   * settles: the pair is what an interrupted run is read back from, and the settled line is printed here
   * rather than a second time at the end of the run.
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

    // Each settle carries the row its line was written from, for an `--events` reader.
    const row = (name: string) => ({
      worker: { name, ok: true, ...UNREAD, url: `https://${name}.acme.workers.dev`, versionId: `ver-${name}` },
    });
    expect(events).toEqual([
      { phase: "start", what: "pithy-api" },
      {
        phase: "settled",
        line: "pithy-api: deployed. https://pithy-api.acme.workers.dev ver-pithy-api",
        data: row("pithy-api"),
      },
      { phase: "start", what: "pithy-web" },
      {
        phase: "settled",
        line: "pithy-web: deployed. https://pithy-web.acme.workers.dev ver-pithy-web",
        data: row("pithy-web"),
      },
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
    const failure = { name: "pithy-api", ok: false, error: "wrangler exited 1." };
    expect(settled[0]).toEqual({ phase: "settled", line: summarizeDeploy(failure), data: { worker: failure } });
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
        if (!bundling(args)) calls.push(args);
        return wranglerOutput("pithy-app", "v1");
      },
    });

    expect(calls).toEqual([["deploy", "--experimental-provision=false", ...STAMPED]]);
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

  /**
   * **Credentials Cloudflare refused stop the run, exit 3, while nothing has shipped.** They are the
   * same for every Worker, so the first refusal is every Worker's: a row per Worker would report one
   * precondition as N failures and exit 1. Once a Worker has shipped, the credentials were good for it, so a
   * later refusal is that Worker's row — and the report of what is already live is not thrown away.
   */
  test("credentials refused before anything shipped end the run as the precondition they are", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");
    const attempted: string[] = [];
    const refusal = new WranglerCredentialsError({ message: "wrangler deploy failed.", action: "Fix the token." });

    const failure = await deployProject({
      account: null,
      projectDir: dir,
      env: "staging",
      runDeploy: async (target) => {
        attempted.push(target.name);
        throw refusal;
      },
    }).catch((error: unknown) => error);

    expect(failure).toBe(refusal);
    expect(exitCodeOf((failure as PithyError).payload)).toBe(3);
    expect(attempted).toEqual(["pithy-api"]);
  });

  test("credentials refused after a Worker shipped are that Worker's row", async () => {
    await writeWorker("api", "pithy-api");
    await writeWorker("web", "pithy-web");

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "staging",
      runDeploy: async (target) => {
        if (target.name === "pithy-web") throw new WranglerCredentialsError({ message: "wrangler deploy failed." });
        return wranglerOutput(target.name, "v3");
      },
    });

    expect(results.map((row) => [row.name, row.ok])).toEqual([
      ["pithy-api", true],
      ["pithy-web", false],
    ]);
  });

  /**
   * **A refusal after an earlier Worker's own failure keeps that failure's row.** Thrown, the run
   * would exit 3 with nothing on stdout, and `--json` would never report that `pithy-api`'s build had failed. The
   * run stops only when no Worker has a row yet; after that, the refusal is its Worker's row, carrying the exit its
   * class names, and the report exits with that class.
   */
  test("credentials refused after an earlier Worker failed keep both rows, and the run exits 3", async () => {
    await writeWorker("api", "pithy-api");
    await writeUi("api");
    await writeWorker("web", "pithy-web");
    const attempted: string[] = [];

    const results = await deployProject({
      account: null,
      projectDir: dir,
      env: "staging",
      runBuild: async () => {
        throw new Error("vite build failed.");
      },
      runDeploy: async (target) => {
        attempted.push(target.name);
        throw new WranglerCredentialsError({ message: "wrangler deploy failed.", action: "Fix the token." });
      },
    });

    expect(attempted).toEqual(["pithy-web"]);
    expect(results).toEqual([
      expect.objectContaining({ name: "pithy-api", ok: false, built: false }),
      expect.objectContaining({ name: "pithy-web", ok: false, exit: EXIT.precondition }),
    ]);
    expect(results[0]).not.toHaveProperty("exit");
    expect(deployFailureExit(results)).toBe(EXIT.precondition);
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

  /**
   * **A row's `error` is wrangler's words without wrangler's color** — stripped where the output is
   * captured, since the `--json` encoder writes every value as it is. The real `runWrangler`, against a stand-in
   * that fails in red.
   */
  test("a failed row's error, from wrangler's captured output, carries no escape sequence", async () => {
    await writeWorker("app", "pithy-app");
    const script = join(dir, "wrangler-stand-in.cjs");
    await writeFile(script, "process.stderr.write('\\u001b[31mAuthentication error\\u001b[0m'); process.exit(1)\n");

    const results = await deployProject({
      account: null,
      projectDir: dir,
      runDeploy: async () => {
        await runWrangler([script, NO_PROVISION_ARG], { account: null, bin: process.execPath });
        return "";
      },
    });

    expect(results[0]?.error).toBe("exit 1\nAuthentication error");
    expect(formatJsonLine({ command: "deploy", workers: results })).not.toContain("\\u001b");
  });

  test("a worker whose output has no version id or url still succeeds with those fields absent", async () => {
    await writeWorker("app", "pithy-app");

    const results = await deployProject({
      account: null,
      projectDir: dir,
      runDeploy: async () => "Deployed. No parseable details here.",
    });

    expect(results).toEqual([{ name: "pithy-app", ok: true, ...UNREAD }]);
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
      runDeploy: async (target, args) => {
        order.push(`${bundling(args) ? "bundle" : "deploy"}:${target.name}`);
        return wranglerOutput(target.name, "v1");
      },
    });

    expect(order).toEqual(["build:pithy-web", "bundle:pithy-web", "deploy:pithy-web"]);
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
      { name: "pithy-api", ok: true, ...UNREAD, versionId: "v1", url: "https://pithy-api.acme.workers.dev" },
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
      runDeploy: async (target, args) => {
        if (!bundling(args)) deployed.push(target.name);
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
        if (!bundling(args)) calls.push(args);
        return wranglerOutput("pithy-web", "v1");
      },
    });

    // vite build writes .wrangler/deploy/config.json, which redirects the plain deploy — no -c, no new flag.
    expect(calls).toEqual([["deploy", "--env", "staging", "--experimental-provision=false", ...STAMPED]]);
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

  /**
   * **`pithy deploy --dry-run`: the build, then `wrangler deploy --dry-run --outdir`, and no upload.** wrangler
   * bundles and validates and stops, so a bundle that does not build fails here, on the Worker's row, rather
   * than at the real deploy. Nothing that only follows an upload happens: no probe of a version that was never
   * shipped, and no audit of a deploy that never ran.
   */
  describe("under --dry-run", () => {
    test("wrangler runs with --dry-run on the real argv, and nothing is probed or audited", async () => {
      await writeWorker("api", "pithy-api");
      const calls: string[][] = [];
      const audited: CliAuditEvent[] = [];

      const results = await deployProject({
        account: null,
        projectDir: dir,
        env: "prod",
        dryRun: true,
        runDeploy: async (_target, args) => {
          calls.push(args);
          return "--dry-run: exiting now.";
        },
        verifyDeploy: async () => {
          throw new Error("A dry run probed an address.");
        },
        audit: async (event) => void audited.push(event),
      });

      expect(calls).toEqual([
        ["deploy", "--env", "prod", "--experimental-provision=false", "--dry-run", "--outdir", expect.any(String)],
      ]);
      expect(results).toEqual([{ name: "pithy-api", ok: true, ...UNREAD }]);
      expect(audited).toEqual([]);
    });

    test("the UI build still runs first, because wrangler bundles what it built", async () => {
      await writeWorker("web", "pithy-web");
      await writeUi("web");
      const order: string[] = [];

      const results = await deployProject({
        account: null,
        projectDir: dir,
        env: "prod",
        dryRun: true,
        runBuild: async (target) => void order.push(`build:${target.name}`),
        runDeploy: async (target, args) => {
          order.push(`${args.includes("--dry-run") ? "--dry-run" : "deploy"}:${target.name}`);
          return "";
        },
      });

      expect(order).toEqual(["build:pithy-web", "--dry-run:pithy-web"]);
      expect(results).toEqual([{ name: "pithy-web", ok: true, built: true, ...UNREAD }]);
    });

    test("a bundle that does not build fails its row with wrangler's error, and the next Worker is still checked", async () => {
      await writeWorker("api", "pithy-api");
      await writeWorker("web", "pithy-web");
      const checked: string[] = [];

      const results = await deployProject({
        account: null,
        projectDir: dir,
        env: "staging",
        dryRun: true,
        runDeploy: async (target) => {
          checked.push(target.name);
          if (target.name === "pithy-api") {
            throw new InternalError({
              message: "wrangler deploy failed.",
              detail: 'X [ERROR] Could not resolve "./missing"',
            });
          }
          return "";
        },
      });

      expect(checked).toEqual(["pithy-api", "pithy-web"]);
      expect(results).toEqual([
        { name: "pithy-api", ok: false, error: 'X [ERROR] Could not resolve "./missing"' },
        { name: "pithy-web", ok: true, ...UNREAD },
      ]);
    });

    test("a failed UI build fails its row, and wrangler never runs for it", async () => {
      await writeWorker("web", "pithy-web");
      await writeUi("web");
      const checked: string[] = [];

      const results = await deployProject({
        account: null,
        projectDir: dir,
        env: "prod",
        dryRun: true,
        runBuild: async () => {
          throw new InternalError({ message: "npx vite build failed.", detail: "Could not resolve ./client" });
        },
        runDeploy: async (target) => {
          checked.push(target.name);
          return "";
        },
      });

      expect(checked).toEqual([]);
      expect(results[0]).toMatchObject({ name: "pithy-web", ok: false, built: false });
      expect(results[0]?.error).toMatch(/Could not resolve/);
    });

    /**
     * **`--dry-run` writes nothing in the project, the build's output included.** A front end's build writes
     * `dist/`, runs whatever hooks its package declares, and leaves a `.wrangler/deploy/config.json` redirect;
     * wrangler bundles under `.wrangler/tmp`. In the project, every one of those is a write a plan said it would not
     * make. So the Workers are built and bundled in a private copy, and the project is byte-identical afterwards —
     * ignored files and all, which is stronger than the tracked and untracked files the promise is about.
     */
    test("the build and wrangler's bundle land in a copy, and the project is byte-identical afterwards", async () => {
      await writeWorker("web", "pithy-web");
      await writeUi("web");
      await mkdir(join(dir, "apps", "web", "src"), { recursive: true });
      await writeFile(join(dir, "apps", "web", "src", "main.ts"), "export {};\n");
      await writeFile(join(dir, ".gitignore"), "dist/\n.wrangler/\n");
      const before = await snapshotTree(dir);
      const at: string[] = [];

      const results = await deployProject({
        account: null,
        projectDir: dir,
        env: "prod",
        dryRun: true,
        runBuild: async (target) => {
          at.push(target.dir);
          // What a real build and its hooks write: output, a redirect, and a generated source file.
          await mkdir(join(target.dir, "dist"), { recursive: true });
          await writeFile(join(target.dir, "dist", "index.js"), "built");
          await mkdir(join(target.dir, ".wrangler", "deploy"), { recursive: true });
          await writeFile(join(target.dir, ".wrangler", "deploy", "config.json"), "{}");
          await writeFile(join(target.dir, "src", "routes.generated.ts"), "export {};\n");
        },
        runDeploy: async (target) => {
          at.push(target.dir);
          await mkdir(join(target.dir, ".wrangler", "tmp"), { recursive: true });
          await writeFile(join(target.dir, ".wrangler", "tmp", "bundle.js"), "bundled");
          return "--dry-run: exiting now.";
        },
      });

      expect(results).toEqual([{ name: "pithy-web", ok: true, built: true, ...UNREAD }]);
      expect(at).toHaveLength(2);
      for (const path of at) expect(path.startsWith(dir)).toBe(false);
      expect(await snapshotTree(dir)).toEqual(before);
    });

    test("a failure in the copy is reported against the project's paths", async () => {
      await writeWorker("web", "pithy-web");
      await writeUi("web");

      const results = await deployProject({
        account: null,
        projectDir: dir,
        env: "prod",
        dryRun: true,
        runBuild: async (target) => {
          throw new InternalError({ message: "vite build failed.", detail: `Could not resolve ${target.dir}/src/x` });
        },
        runDeploy: async () => "",
      });

      expect(results[0]?.error).toBe(`Could not resolve ${join(dir, "apps", "web")}/src/x`);
    });

    test("each Worker is checked under a step, and settles as what would happen", async () => {
      await writeWorker("api", "pithy-api");
      const events: ProgressEvent[] = [];

      await narrate(
        (event) => events.push(event),
        async () => {
          await deployProject({ account: null, projectDir: dir, env: "prod", dryRun: true, runDeploy: async () => "" });
        },
      );

      expect(events).toEqual([
        { phase: "start", what: "pithy-api" },
        {
          phase: "settled",
          line: `pithy-api: would deploy. ${UNREAD.reason}`,
          data: { worker: { name: "pithy-api", ok: true, ...UNREAD } },
        },
      ]);
    });
  });
});

/**
 * **A deploy cannot publish a configuration that is not the requested environment's.**
 *
 * A build handed only `ENVIRONMENT`, which `@cloudflare/vite-plugin` does not read to select a wrangler
 * environment, emits the top-level stanza; the `.wrangler/deploy/config.json` it writes then redirects
 * `wrangler deploy` to that flattened output, where `--env staging` matches nothing, and a Worker composed
 * as `dev` would ship publicly as staging.
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
        if (!bundling(args)) argv.push(args);
        return wranglerOutput("acme-web-staging", "v1");
      },
    });

    expect(results[0]).toMatchObject({ name: "acme-web", ok: true, built: true });
    expect(argv).toEqual([["deploy", "--env", "staging", "--experimental-provision=false", ...STAMPED]]);
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
        if (!bundling(args)) argv.push(args);
        return wranglerOutput("acme-web", "v1");
      },
    });

    expect(results[0]).toMatchObject({ ok: true });
    expect(argv).toEqual([["deploy", "--experimental-provision=false", ...STAMPED]]);
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
        if (!bundling(args)) argv.push(args);
        return wranglerOutput("acme-api-staging", "v1");
      },
    });

    expect(results[0]).toMatchObject({ ok: true });
    expect(argv).toEqual([["deploy", "--env", "staging", "--experimental-provision=false", ...STAMPED]]);
  });

  test("a feature environment builds against its generated config and stops passing --config", async () => {
    // `--config` beats the redirect, and the source config has no `assets.directory`, so a UI Worker's
    // feature deploy must not pass it. The generated config reaches the build instead, which is where the
    // asset wiring is written.
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
        if (!bundling(args)) argv.push(args);
        return wranglerOutput("acme-web-pr-7", "v1");
      },
    });

    expect(results[0]).toMatchObject({ ok: true, built: true });
    expect(argv).toEqual([["deploy", "--env", "feature", "--experimental-provision=false", ...STAMPED]]);
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
        if (!bundling(args)) argv.push(args);
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
        ...STAMPED,
      ],
    ]);
  });
});

/**
 * **`pithy deploy --env feature` verifies what it just deployed.** A feature's stanza lives in the generated
 * config, never in the tracked `wrangler.jsonc`, so verification reads the generated config the way
 * `readAddressStanza` does; reading the tracked file would find no stanza, no address, and never probe.
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

/**
 * **An app Worker is uploaded only when its bundle or configuration moved.** Its stamp is a hash of what
 * `wrangler deploy --dry-run --outdir` wrote and the configuration wrangler reads. The upload carries
 * `unfinished`, and the stamp is recorded over it once the deploy and its verification have passed.
 */
describe("an app Worker's deploy stamp", () => {
  let dir: string;
  statesItsOwnEnvironment();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-deploy-stamp-"));
    const at = join(dir, "apps", "api");
    await mkdir(at, { recursive: true });
    await writeFile(
      join(at, "wrangler.jsonc"),
      JSON.stringify({ name: "acme-api", env: { prod: { name: "acme-prod-api" } } }),
    );
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    calls = [];
    written = [];
    source = "var x = 1;";
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Every argv wrangler was handed, in order. */
  let calls: string[][];
  /** Every var recorded on a deployed Worker after its deploy: script, name, value. */
  let written: string[][];
  /** The code the bundle pass writes under a dependency's path comment, as esbuild writes it from where wrangler ran. */
  let source: string;

  const runDeploy = async (target: { dir: string }, args: string[]): Promise<string> => {
    calls.push(args);
    const outdir = args[args.indexOf("--outdir") + 1];
    if (bundling(args) && outdir) {
      const dep = relative(target.dir, join(await realpath(dir), "node_modules", "dep", "index.js"));
      await writeFile(join(outdir, "index.js"), `// ${dep}\n${source}\n`);
      await writeFile(join(outdir, "README.md"), `written at ${Math.random()}`);
    }
    return wranglerOutput("acme-prod-api", "v1");
  };

  /** The value the one upload carried in the stamp var. */
  const uploadedStamp = (): string | undefined =>
    calls
      .filter((args) => !bundling(args))
      .flat()
      .find((arg) => arg.startsWith("PITHY_DEPLOY_STAMP:"))
      ?.slice("PITHY_DEPLOY_STAMP:".length);

  /** The stamp recorded after the deploy finished, or `undefined` when none was. */
  const recordedStamp = (): string | undefined => written.find(([, name]) => name === "PITHY_DEPLOY_STAMP")?.[2];

  const deploy = (options: Partial<Parameters<typeof deployProject>[0]> = {}) =>
    deployProject({
      account: null,
      projectDir: dir,
      env: "prod",
      runDeploy,
      writeVar: async (script, name, value) => void written.push([script, name, value]),
      ...options,
    });

  /** Deploy once against an unstamped Worker, and return the stamp it recorded. */
  async function firstDeploy(): Promise<string> {
    await deploy({ readVars: async () => ({}) });
    const stamp = recordedStamp();
    calls = [];
    written = [];
    return stamp as string;
  }

  test("a Worker with no stamp deploys, uploads the unfinished marker, and records its stamp once it finished", async () => {
    const results = await deploy({ readVars: async () => ({}) });
    expect(results[0]).toMatchObject({ ok: true, outcome: "deployed", reason: "It carried no deploy stamp." });
    expect(uploadedStamp()).toBe("unfinished");
    expect(written).toEqual([["acme-prod-api", "PITHY_DEPLOY_STAMP", expect.stringMatching(/^[0-9a-f]{32}$/)]]);
  });

  test("a Worker left unfinished by a failed deploy deploys again, and says why", async () => {
    const results = await deploy({ readVars: async () => ({ PITHY_DEPLOY_STAMP: "unfinished" }) });
    expect(results[0]).toMatchObject({
      ok: true,
      outcome: "deployed",
      reason: "Its last deploy did not record that it finished.",
    });
    expect(calls.filter((args) => !bundling(args))).toHaveLength(1);
  });

  test("a stamp that cannot be recorded leaves the row deployed, and says the next run uploads again", async () => {
    const results = await deploy({
      readVars: async () => ({}),
      writeVar: async () => {
        throw new Error("403 Forbidden");
      },
    });
    expect(results[0]).toMatchObject({
      ok: true,
      outcome: "deployed",
      reason:
        "It carried no deploy stamp. Its deploy stamp could not be recorded, so the next deploy uploads it again. 403 Forbidden",
    });
  });

  test("a Worker whose live stamp matches is unchanged, says why, and wrangler uploads nothing", async () => {
    const stamp = await firstDeploy();
    const audited: CliAuditEvent[] = [];
    const asked: string[] = [];
    const events: ProgressEvent[] = [];
    const results = await narrate(
      (event) => events.push(event),
      () =>
        deploy({
          readVars: async (script) => {
            asked.push(script);
            return { PITHY_DEPLOY_STAMP: stamp };
          },
          audit: async (event) => void audited.push(event),
          verifyDeploy: async () => {
            throw new Error("An unchanged Worker was probed.");
          },
        }),
    );
    expect(results).toEqual([
      {
        name: "acme-api",
        ok: true,
        outcome: "unchanged",
        reason: "This bundle and configuration are already deployed.",
      },
    ]);
    expect(asked).toEqual(["acme-prod-api"]);
    expect(calls.filter((args) => !bundling(args))).toEqual([]);
    expect(audited).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      line: "acme-api: unchanged. This bundle and configuration are already deployed.",
    });
  });

  test("a change to the bundle changes the stamp and deploys", async () => {
    const stamp = await firstDeploy();
    source = "var x = 2;";
    const results = await deploy({ readVars: async () => ({ PITHY_DEPLOY_STAMP: stamp }) });
    expect(results[0]).toMatchObject({ outcome: "deployed", reason: "Its bundle or resolved configuration changed." });
    expect(recordedStamp()).not.toBe(stamp);
  });

  test("a change to the configuration changes the stamp and deploys", async () => {
    const stamp = await firstDeploy();
    await writeFile(
      join(dir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({ name: "acme-api", env: { prod: { name: "acme-prod-api", vars: { FLAG: "on" } } } }),
    );
    const results = await deploy({ readVars: async () => ({ PITHY_DEPLOY_STAMP: stamp }) });
    expect(results[0]).toMatchObject({ outcome: "deployed", reason: "Its bundle or resolved configuration changed." });
  });

  test("a run that differs only in when privacy was attested is unchanged", async () => {
    const attested = (attestedAt: string) => ({
      classes: [],
      consoleGate: "not_required" as const,
      reason: null,
      attestedAt,
    });
    await deploy({ readVars: async () => ({}), privacy: attested("2026-10-20T12:00:00.000Z") });
    const stamp = recordedStamp() as string;
    calls = [];
    const results = await deploy({
      readVars: async () => ({ PITHY_DEPLOY_STAMP: stamp }),
      privacy: attested("2026-10-21T08:30:00.000Z"),
    });
    expect(results[0]).toMatchObject({ outcome: "unchanged" });
    expect(calls.filter((args) => !bundling(args))).toEqual([]);
  });

  test("--force uploads an unchanged Worker, and reads nothing", async () => {
    const stamp = await firstDeploy();
    let read = 0;
    const results = await deploy({
      force: true,
      readVars: async () => {
        read += 1;
        return { PITHY_DEPLOY_STAMP: stamp };
      },
    });
    expect(results[0]).toMatchObject({ outcome: "deployed", reason: "--force was given." });
    expect(read).toBe(0);
    expect(recordedStamp()).toBe(stamp);
  });

  test("a deploy that fails after its upload records no stamp, so the re-run deploys again", async () => {
    // wrangler uploads, then fails setting a trigger: the code is live carrying only the marker.
    const results = await deploy({
      readVars: async () => null,
      runDeploy: async (target, args) => {
        if (!bundling(args)) {
          calls.push(args);
          throw new InternalError({ message: "wrangler deploy failed.", detail: "A custom domain is already in use." });
        }
        return runDeploy(target, args);
      },
    });
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]).not.toHaveProperty("outcome");
    expect(uploadedStamp()).toBe("unfinished");
    expect(written).toEqual([]);

    calls = [];
    const rerun = await deploy({ readVars: async () => ({ PITHY_DEPLOY_STAMP: "unfinished" }) });
    expect(rerun[0]).toMatchObject({ ok: true, outcome: "deployed" });
    expect(calls.filter((args) => !bundling(args))).toHaveLength(1);
  });

  describe("a deploy whose declared address is checked", () => {
    beforeEach(async () => {
      await writeFile(
        join(dir, "apps", "api", "wrangler.jsonc"),
        JSON.stringify({
          name: "acme-api",
          env: { prod: { name: "acme-prod-api", vars: { BASE_URL: "https://api.acme.example" } } },
        }),
      );
    });

    const probing = (status: "verified" | "mismatch" | "unreachable" | "inconclusive") => async () => ({
      status,
      observed: ["v0"],
      attempts: 3,
      detail: `https://api.acme.example is ${status}.`,
    });

    test("records its stamp once the address serves the version just shipped", async () => {
      const results = await deploy({ readVars: async () => ({}), verifyDeploy: probing("verified") });
      expect(results[0]).toMatchObject({ ok: true, verification: "verified" });
      expect(recordedStamp()).toMatch(/^[0-9a-f]{32}$/);
    });

    test("an inconclusive check does not fail the deploy, so it records its stamp", async () => {
      await deploy({ readVars: async () => ({}), verifyDeploy: probing("inconclusive") });
      expect(recordedStamp()).toMatch(/^[0-9a-f]{32}$/);
    });

    test.each(["mismatch", "unreachable"] as const)(
      "a %s records no stamp, so a re-run with nothing fixed uploads and probes again",
      async (status) => {
        const failed = await deploy({ readVars: async () => ({}), verifyDeploy: probing(status) });
        expect(failed[0]).toMatchObject({ ok: true, verification: status });
        expect(deployVerificationFailed(failed)).toBe(true);
        expect(written).toEqual([]);

        calls = [];
        let probed = 0;
        const rerun = await deploy({
          readVars: async () => ({ PITHY_DEPLOY_STAMP: "unfinished" }),
          verifyDeploy: async () => {
            probed += 1;
            return probing(status)();
          },
        });
        expect(rerun[0]).toMatchObject({ outcome: "deployed", verification: status });
        expect(probed).toBe(1);
        expect(deployVerificationFailed(rerun)).toBe(true);
      },
    );
  });

  test("--dry-run reaches the deploy's verdict, bundled in a copy of the project", async () => {
    const stamp = await firstDeploy();
    const planned = await deploy({ dryRun: true, readVars: async () => ({ PITHY_DEPLOY_STAMP: stamp }) });
    expect(planned).toEqual([
      {
        name: "acme-api",
        ok: true,
        outcome: "unchanged",
        reason: "This bundle and configuration are already deployed.",
      },
    ]);
    // The copy is somewhere else, so the dependency's path comment differed; the stamp did not.
    expect(calls.every(bundling)).toBe(true);

    source = "var x = 3;";
    const moved = await deploy({ dryRun: true, readVars: async () => ({ PITHY_DEPLOY_STAMP: stamp }) });
    expect(moved[0]).toMatchObject({ outcome: "deployed", reason: "Its bundle or resolved configuration changed." });
  });

  describe("a first deploy Cloudflare has not propagated yet", () => {
    const unseen = () =>
      new InternalError({
        message: "wrangler deploy failed.",
        detail:
          "exit 1\n✘ [ERROR] A request to the Cloudflare API (/accounts/a/workers/workers/acme-prod-api) failed.\n  This Worker does not exist on your account. [code: 10007]",
      });

    test("is uploaded once more after a wait, and reported deployed", async () => {
      let uploads = 0;
      const waits: number[] = [];
      const results = await deploy({
        retryWait: async (ms) => void waits.push(ms),
        runDeploy: async (target, args) => {
          if (!bundling(args) && ++uploads === 1) throw unseen();
          return runDeploy(target, args);
        },
      });
      expect(uploads).toBe(2);
      expect(waits).toHaveLength(1);
      expect(results[0]).toMatchObject({ ok: true, outcome: "deployed", versionId: "v1" });
      expect(recordedStamp()).toMatch(/^[0-9a-f]{32}$/);
    });

    test("a second 10007 fails the row, with no third attempt", async () => {
      let uploads = 0;
      const results = await deploy({
        retryWait: async () => {},
        runDeploy: async (target, args) => {
          if (bundling(args)) return runDeploy(target, args);
          uploads += 1;
          throw unseen();
        },
      });
      expect(uploads).toBe(2);
      expect(results[0]).toMatchObject({ ok: false });
      expect(results[0]?.error).toContain("[code: 10007]");
      expect(written).toEqual([]);
    });

    test("any other failure is not retried", async () => {
      let uploads = 0;
      const results = await deploy({
        retryWait: async () => {},
        runDeploy: async (target, args) => {
          if (bundling(args)) return runDeploy(target, args);
          uploads += 1;
          throw new InternalError({ message: "wrangler deploy failed.", detail: "exit 1\n[code: 10021]" });
        },
      });
      expect(uploads).toBe(1);
      expect(results[0]).toMatchObject({ ok: false });
    });
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
   * a verification that fails the command.
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
   * `deployed.` with the probe's finding indented underneath would report a Worker composed as `dev` as live
   * on a public URL. The upload happened and the line still says so; what it must not say is that the deploy
   * was fine.
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

describe("summarizePlannedDeploy", () => {
  test("a Worker that bundled would deploy", () => {
    expect(summarizePlannedDeploy({ name: "api", ok: true })).toBe("api: would deploy.");
  });

  test("a Worker that also built says so", () => {
    expect(summarizePlannedDeploy({ name: "web", ok: true, built: true })).toBe("web: built, and would deploy.");
  });

  test("a failure reads exactly as the real run's", () => {
    const failed = { name: "web", ok: false, built: false, error: "Could not resolve ./client" };
    expect(summarizePlannedDeploy(failed)).toBe(summarizeDeploy(failed));
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
 * The scrape of wrangler's own output.
 *
 * `\S+` runs to the next space, and wrangler wraps an address in a quote or a bracket, so a scrape that kept
 * them would report `https://staging.app.pithy.sh")` as an address: one that reaches nothing when copied, read
 * as a fact with the punctuation invisible at a glance.
 *
 * And `wrangler deploy` prints a telemetry notice after the deploy summary, so a scrape that took the last URL
 * in stdout would report its documentation link. The address comes from wrangler's own `Deployed <name>
 * triggers` block and only from a target that is an address, so every case below is written the way wrangler
 * prints it — a heading with its targets indented beneath it.
 */
describe("what a deploy reports, scraped out of wrangler's prose", () => {
  const parse = deployOutput.parse;
  const address = deployOutput.address;

  /** Wrangler's triggers block around some targets — the shape every address it reports arrives in. */
  function triggers(...targets: string[]): string {
    return ["Deployed dash-board triggers (0.50 sec)", ...targets.map((target) => `  ${target}`)].join("\n");
  }

  test("wrangler's telemetry notice is never reported as the Worker's address", () => {
    // The deploy of 2026-10-02 that reported the telemetry doc as a Worker's public address.
    expect(parse(wranglerOutputWithTelemetryNotice())).toEqual({
      versionId: "0a4402fb-d36e-408d-b461-c6502ee34c16",
      url: "https://staging.app.pithy.sh",
    });
  });

  test("a workers.dev target is the address wrangler already wrote a scheme on", () => {
    expect(address("https://dash-board.pithy.workers.dev")).toBe("https://dash-board.pithy.workers.dev");
  });

  test("a custom domain is the host it answers on, without wrangler's annotation", () => {
    expect(address("staging.app.pithy.sh (custom domain - zone name: pithy.sh)")).toBe("https://staging.app.pithy.sh");
    // `renderRoute` appends the enabled/previews flags too, when the route declares them.
    expect(address("staging.app.pithy.sh (custom domain - zone id: 9f1) [enabled, previews: disabled]")).toBe(
      "https://staging.app.pithy.sh",
    );
  });

  test("a route reports the host it answers on, not the pattern it matches", () => {
    expect(address("api.acme.com/v1/* (zone name: acme.com)")).toBe("https://api.acme.com");
    // A wildcard names a shape of host rather than a host, so there is no address to report.
    expect(address("*.acme.com/*")).toBeUndefined();
  });

  test("a trigger that is not an address is not reported as one", () => {
    expect(address("schedule: */5 * * * *")).toBeUndefined();
    expect(address("Producer for emails")).toBeUndefined();
    expect(address("Consumer for emails")).toBeUndefined();
    expect(address("workflow: Onboarding")).toBeUndefined();
    expect(address("event triggers: 2")).toBeUndefined();
    expect(address("...and 3 more routes")).toBeUndefined();
  });

  test("an address wrapped by the sentence around it comes back as an address", () => {
    // Quoted inside a bracket, read as the target it is.
    expect(parse(triggers('("https://staging.app.pithy.sh")')).url).toBe("https://staging.app.pithy.sh");
  });

  test("a bracket the address itself opened is part of the address", () => {
    // Legal, rare, and somebody's real path. The trailing bracket is dropped only when the token
    // holds no opener to match it.
    expect(address("https://example.com/wiki/Thing_(disambiguation)")).toBe(
      "https://example.com/wiki/Thing_(disambiguation)",
    );
    expect(address('("https://example.com/wiki/Thing_(disambiguation)")')).toBe(
      "https://example.com/wiki/Thing_(disambiguation)",
    );
  });

  test("the version id is trimmed the same way, for the same reason", () => {
    expect(parse("Version ID: 7908726e-a1a8-4111-8e56-4d34d23fab45").versionId).toBe(
      "7908726e-a1a8-4111-8e56-4d34d23fab45",
    );
    expect(parse('Version ID: "7908726e".').versionId).toBe("7908726e");
  });

  test("the address comes out of the block, not out of a link printed before it", () => {
    const stdout = [
      "See https://developers.cloudflare.com/workers for help.",
      triggers("https://acme-api.acme.workers.dev"),
      "Current Version ID: v1",
      TELEMETRY_NOTICE,
    ].join("\n");
    expect(parse(stdout)).toEqual({ versionId: "v1", url: "https://acme-api.acme.workers.dev" });
  });

  test("the first target that is an address is the one reported", () => {
    const block = triggers("schedule: */5 * * * *", "staging.app.pithy.sh (custom domain - zone name: pithy.sh)");
    expect(parse(block).url).toBe("https://staging.app.pithy.sh");
  });

  test("the block ends where wrangler stops indenting", () => {
    // Nothing below `Current Version ID:` is a target, however much it looks like one.
    const stdout = [triggers("schedule: */5 * * * *"), "Current Version ID: v1", "  https://not.a-target.example"].join(
      "\n",
    );
    expect(parse(stdout)).toEqual({ versionId: "v1" });
  });

  test("no targets deployed is no address, not the notice below it", () => {
    const stdout = ["No targets deployed for dash-board (0.50 sec)", "Current Version ID: v1", TELEMETRY_NOTICE].join(
      "\n",
    );
    expect(parse(stdout)).toEqual({ versionId: "v1" });
  });

  test("finding nothing is an ordinary answer, not a failure", () => {
    expect(parse("Total Upload: 512 KiB\n")).toEqual({});
    expect(parse(["Total Upload: 512 KiB", "Current Version ID: v1", TELEMETRY_NOTICE].join("\n"))).toEqual({
      versionId: "v1",
    });
  });
});
