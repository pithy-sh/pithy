// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { InternalError, messageOf, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import type { CliAuditEmit } from "../audit/cliAudit";
import { red } from "../terminal/style";
import { loadWorkerConfig, loadWorkerDomains } from "./config";
import { detectPackageManager, execArgs, type PackageManager } from "./packageManager";
import type { DeployVerification, VerifyDeployResult } from "./verifyDeploy";
import { isDeployFailure, verifyDeployedVersion } from "./verifyDeploy";
import { type AddressStanza, resolveWorkerAddress } from "./workerAddress";
import { parseWorkerManifest } from "./workerManifest";
import { discoverWorkers, type WorkerTarget } from "./workers";
import { readWranglerConfig, runWrangler } from "./wrangler";

/** The `wrangler deploy` runner for one worker — injectable so tests exercise orchestration without wrangler. */
export type RunDeploy = (target: WorkerTarget, args: string[]) => Promise<string>;

/**
 * The UI build runner for one worker — injectable so tests exercise orchestration without a real build.
 *
 * `environment` is not optional decoration. `@pithy-sh/vite` resolves each capability's client-safe
 * projection *for a named environment* at build time — a Turnstile sitekey differs per environment, and
 * the plugin falls back to `dev` when nothing says otherwise. A build that does not carry the deploy's
 * `--env` therefore inlines dev values into a production bundle, which for Turnstile means shipping
 * Cloudflare's always-passes test sitekey. It is silent, and it defeats the gate entirely.
 */
export type RunBuild = (
  target: WorkerTarget,
  command: string,
  args: string[],
  environment: string | undefined,
) => Promise<void>;

export interface DeployProjectOptions {
  /** The project root — the parent of `apps/`, where every Worker lives. */
  projectDir: string;
  /** Target environment; omitted deploys each worker's top-level config (no `--env`). */
  env?: string;
  /** Test seam: run one worker's deploy and return its captured stdout. Defaults to real wrangler. */
  runDeploy?: RunDeploy;
  /** Test seam: run one worker's UI build. Defaults to the real package-manager invocation. */
  runBuild?: RunBuild;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /**
   * Test seam: probe a declared domain for the version just shipped. Defaults to the real HTTP probe.
   *
   * Injected rather than reached for, so the deploy tests never touch the network and the retry/backoff
   * behaviour is exercised without waiting for it.
   */
  verifyDeploy?: VerifyDeploy;
}

/** Probe one address for one expected version. The seam `verifyDeployedVersion` fills by default. */
export type VerifyDeploy = (options: { url: string; expectedVersion: string }) => Promise<VerifyDeployResult>;

/**
 * Shipping code is production-affecting the moment `prod` is the named target — everything else
 * (`staging`, a bare deploy with no `--env`) is routine. Exported so the command layer and tests agree on
 * the same rule.
 */
export function deploySeverity(env: string | undefined): "info" | "warning" {
  return env === "prod" ? "warning" : "info";
}

/** One worker's deploy outcome — the `--json` row and the human summary line both read from this. */
export interface WorkerDeploy {
  /** The worker's name. */
  name: string;
  /** Whether `wrangler deploy` succeeded for this worker. */
  ok: boolean;
  /** The deployed version id, when wrangler's output carried one. */
  versionId?: string;
  /** The worker's public URL, when wrangler's output carried one. */
  url?: string;
  /**
   * Whether this worker's UI build ran and succeeded. Absent when the worker declares no `ui` block —
   * so `false` means the build is what failed, and the deploy never ran.
   */
  built?: boolean;
  /** The failure reason, present only when `ok` is false. */
  error?: string;
  /**
   * What probing the **declared** domain concluded about the version just shipped.
   *
   * Absent when there was nothing to check: a bare `pithy deploy` with no `--env` has no environment to
   * resolve a domain for, and a Worker that declares no address has no domain to probe. Present and
   * `mismatch` is the one case that fails the command — see `isDeployFailure`.
   */
  verification?: DeployVerification;
  /** The one-line explanation behind `verification`, for the summary and the `--json` row. */
  verificationDetail?: string;
}

/** Scrape the version id and public url from `wrangler deploy` output — best-effort, both optional. */
function parseDeployOutput(stdout: string): { versionId?: string; url?: string } {
  const summary: { versionId?: string; url?: string } = {};
  const version = stdout.match(/Version ID:\s*(\S+)/);
  if (version) summary.versionId = version[1];
  // The deployed URL is the last one wrangler prints (after upload), not an earlier docs/dashboard link.
  const urls = stdout.match(/https?:\/\/\S+/g);
  if (urls) summary.url = urls[urls.length - 1];
  return summary;
}

/**
 * The failure reason for a thrown deploy. For a `PithyError` (how `runWrangler` reports a non-zero
 * exit) that means the `detail` — wrangler's captured exit code and stderr, the part a CI operator
 * needs — not just the generic public `message`. Anything else falls back to the shared `messageOf`.
 */
function reasonOf(error: unknown): string {
  if (error instanceof PithyError) return error.payload.detail ?? error.payload.message;
  return messageOf(error);
}

/**
 * The default deploy step: `wrangler deploy [--env <env>]` in the worker's directory, quiet on
 * success (its output is captured and summarized, not streamed — the brand voice). Wrangler reads
 * `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, so CI needs no interactive login; we also pass them
 * from `.dev.vars` so a local deploy authenticates the same way.
 */
function defaultRunDeploy(projectDir: string): RunDeploy {
  const vars = loadCloudflareEnv(projectDir);
  const env: Record<string, string> = {};
  if (vars.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = vars.CLOUDFLARE_API_TOKEN;
  if (vars.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = vars.CLOUDFLARE_ACCOUNT_ID;
  return async (target, args) => {
    const { stdout } = await runWrangler(args, { cwd: target.dir, env });
    return stdout;
  };
}

const runProcess = promisify(execFile);

/**
 * The default UI build step: the worker's `ui.build` argv, through the project's package manager, in the
 * worker's own directory. Quiet on success like the deploy step — the output is captured and surfaced only
 * as the failure `detail`. A build's chunk table can be long, so the buffer is generous; truncation would
 * turn a real failure into a confusing one.
 */
const defaultRunBuild: RunBuild = async (target, command, args, environment) => {
  try {
    await runProcess(command, args, {
      cwd: target.dir,
      maxBuffer: 16 * 1024 * 1024,
      // `ENVIRONMENT` is the same signal the deployed Worker reads (wrangler.jsonc `vars`), and it is
      // what the Vite plugin resolves each capability's projection against. Absent, it builds `dev`.
      ...(environment ? { env: { ...process.env, ENVIRONMENT: environment } } : {}),
    });
  } catch (cause) {
    throw new InternalError({
      message: `${command} ${args.join(" ")} failed.`,
      action: `Build ${target.name} by hand: ${command} ${args.join(" ")}.`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

/**
 * The build command for one worker, or `undefined` when it serves no front end. The SPA lives in the Worker
 * that serves it, so its assets have to exist before `wrangler deploy` uploads them. `vite build` also writes
 * `.wrangler/deploy/config.json` in the worker's directory, which redirects the following plain
 * `wrangler deploy` to the built config — so the deploy argv needs no `-c` and does not change.
 */
async function uiBuild(
  worker: WorkerTarget,
  packageManager: PackageManager,
): Promise<{ command: string; args: string[] } | undefined> {
  const manifest = await parseWorkerManifest(worker.dir);
  const build = manifest?.ui?.build;
  if (!build || build.length === 0) return undefined;
  return execArgs(packageManager, build[0] as string, build.slice(1));
}

/**
 * Deploy the project's Workers — the logic behind `pithy deploy`. It enumerates the worker registry
 * (`apps/*` — there is no root Worker) and runs `wrangler deploy` in each worker's own directory, against
 * that worker's own `wrangler.jsonc`, letting wrangler own bundling, upload, bindings, and routes. One
 * worker's failure does not abort the batch: every worker is attempted and reported, so the caller can
 * exit non-zero if any `ok` is false.
 *
 * A worker that serves a front end (a `ui` block in its `pithy.worker.jsonc`) is **built first**, in its own
 * directory, through the adopter's package manager. A failed build fails that worker and skips its deploy —
 * shipping a Worker whose assets are stale, or missing, is worse than not shipping it.
 */
/**
 * Probe one Worker's declared domain for the version just shipped, or return null when there is nothing
 * to check.
 *
 * Three ways to have nothing to check, and all three are ordinary rather than failures. **No `--env`**:
 * a bare `pithy deploy` ships each Worker's top-level stanza, which is the `dev` environment, and `dev`
 * has no public address by design. **No version id**: wrangler printed none, so there is nothing to
 * correlate against. **No declared address**: the Worker has no domain, no route, and no `BASE_URL`, so
 * there is nowhere to probe — and inventing `workers.dev` here would be exactly the assumption #89 rules
 * out, since the subdomain can be disabled per account and commonly is in production.
 */
async function verifyWorkerDeploy(
  worker: WorkerTarget,
  env: string | undefined,
  versionId: string | undefined,
  probe: VerifyDeploy,
): Promise<VerifyDeployResult | null> {
  if (!env || env === "dev" || !versionId) return null;

  let domains: WorkerDomains | undefined;
  try {
    domains = loadWorkerDomains(await loadWorkerConfig(worker.dir));
  } catch {
    domains = undefined;
  }

  let stanza: AddressStanza | undefined;
  try {
    stanza = ((await readWranglerConfig(worker.dir)) as { env?: Record<string, AddressStanza | undefined> }).env?.[env];
  } catch {
    stanza = undefined;
  }

  const address = resolveWorkerAddress({ environment: env, domains, stanza });
  if (!address) return null;

  return probe({ url: address.url, expectedVersion: versionId });
}

export async function deployProject(options: DeployProjectOptions): Promise<WorkerDeploy[]> {
  // Only real Workers deploy. A non-Worker process in the dev set (a Vite frontend with a
  // `pithy.worker.jsonc` but no `wrangler.jsonc`) has nothing for `wrangler deploy` to ship.
  const workers = (await discoverWorkers(options.projectDir)).filter((worker) => worker.hasWrangler !== false);
  if (workers.length === 0) {
    throw new NotFoundError({
      message: "No deployable workers here.",
      action: "Every worker lives in apps/<name> with its own wrangler.jsonc. Run pithy worker add <name>.",
    });
  }

  const run = options.runDeploy ?? defaultRunDeploy(options.projectDir);
  const build = options.runBuild ?? defaultRunBuild;
  const packageManager = await detectPackageManager(options.projectDir);
  const args = options.env ? ["deploy", "--env", options.env] : ["deploy"];
  const audit = options.audit ?? (async () => {});
  const probe = options.verifyDeploy ?? ((probeOptions) => verifyDeployedVersion(probeOptions));
  const severity = deploySeverity(options.env);

  const deploys: WorkerDeploy[] = [];
  for (const worker of workers) {
    // Stays undefined for an API-only worker, turns false while a UI worker's build is in flight: a
    // `built: false` row is how a `--json` consumer reads "the build failed, the deploy never ran".
    let built: boolean | undefined;
    try {
      const ui = await uiBuild(worker, packageManager);
      if (ui) {
        built = false;
        await build(worker, ui.command, ui.args, options.env);
        built = true;
      }
      const stdout = await run(worker, args);
      const deploy: WorkerDeploy = {
        name: worker.name,
        ok: true,
        ...parseDeployOutput(stdout),
        ...(built === undefined ? {} : { built }),
      };
      // Prove the Worker just shipped is the one answering at the address this project claims. Not a
      // liveness probe — the old version answering happily is exactly the failure worth catching — and
      // not a comparison against the URL wrangler printed, which under versions may be a version-scoped
      // preview rather than the stable route.
      const verified = await verifyWorkerDeploy(worker, options.env, deploy.versionId, probe);
      if (verified) {
        deploy.verification = verified.status;
        deploy.verificationDetail = verified.detail;
      }
      deploys.push(deploy);
      await audit({
        action: "deploy/worker_deployed",
        outcome: "success",
        severity,
        resourceType: "cf_worker",
        resourceId: worker.name,
        // Neither `worker` nor `env` belongs here any more. The environment is the `environment`
        // column the recorder stamps, and the Worker deployed is already `resourceId` — which is
        // also the truer home for it, since that Worker is what this action *targeted*, not where
        // the action came from (a CLI deploy comes from no Worker at all).
        metadata: { versionId: deploy.versionId ?? null, verification: deploy.verification ?? null },
      });
    } catch (error) {
      const reason = reasonOf(error);
      deploys.push({ name: worker.name, ok: false, ...(built === undefined ? {} : { built }), error: reason });
      // A failed deploy is exactly what an audit trail is for — record it too, not just successes.
      await audit({
        action: "deploy/worker_deployed",
        outcome: "failure",
        severity,
        resourceType: "cf_worker",
        resourceId: worker.name,
        // Same as the success path: `worker` is `resourceId` and `env` is the `environment` column.
        // What stays is what is genuinely per-event — which stage failed, and why.
        metadata: {
          stage: built === false ? "build" : "deploy",
          error: reason,
        },
      });
    }
  }
  return deploys;
}

/** One worker's human summary line — brand voice; red on failure, url + version id on success. */
export function summarizeDeploy(deploy: WorkerDeploy): string {
  // A build failure and a deploy failure are different problems with different fixes, so they read differently.
  if (!deploy.ok) {
    const problem = deploy.built === false ? "build failed." : "failed.";
    return red(`${deploy.name}: ${problem}`) + (deploy.error ? ` ${deploy.error}` : "");
  }
  const detail = [deploy.url, deploy.versionId].filter(Boolean).join(" ");
  const line = detail ? `${deploy.name}: deployed. ${detail}` : `${deploy.name}: deployed.`;
  // Wrangler's own URL keeps appearing above, as it always did — it tells a human where their deploy
  // went. The verification line below is the separate question of whether the *declared* address is now
  // serving what was just shipped, and it is the only one that can fail the command.
  if (!deploy.verification || deploy.verification === "verified") return line;
  const note = deploy.verificationDetail ?? "";
  return deploy.verification === "mismatch" ? `${line}\n  ${red(note)}` : `${line}\n  ${note}`;
}

/** Whether any Worker's declared address is consistently serving something other than what just shipped. */
export function deployVerificationFailed(deploys: readonly WorkerDeploy[]): boolean {
  return deploys.some((deploy) => deploy.verification !== undefined && isDeployFailure(deploy.verification));
}

/**
 * The warn line when the target env's schema is behind — deploy never migrates, so it only surfaces
 * the drift and points at `pithy migrate`. `undefined` when nothing is pending or the count is unknown.
 */
export function pendingWarning(pending: number | undefined, env: string): string | undefined {
  if (!pending || pending <= 0) return undefined;
  const plural = pending === 1 ? "" : "s";
  return `${pending} migration${plural} unapplied for ${env}. Deploy does not migrate — run pithy migrate --env ${env}.`;
}
