// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InternalError, messageOf, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { isSourceEnvironment, wranglerConfigPath } from "../provision/featureConfig";
import { settleStep, startStep } from "../terminal/progress";
import { red } from "../terminal/style";
import { loadWorkerConfig, loadWorkerDomains } from "./config";
import {
  assertCreatesNoResources,
  assertDeploysRequestedEnvironment,
  NO_PROVISION_ARG,
  wranglerEnvironment,
} from "./effectiveConfig";
import { detectPackageManager, execArgs, type PackageManager } from "./packageManager";
import type { DeployVerification, VerifyDeployResult } from "./verifyDeploy";
import { isDeployFailure, verifyDeployedVersion } from "./verifyDeploy";
import { readAddressStanza, resolveWorkerAddress } from "./workerAddress";
import { parseWorkerManifest } from "./workerManifest";
import { discoverWorkers, type WorkerTarget } from "./workers";
import { runWrangler } from "./wrangler";

/** The `wrangler deploy` runner for one worker — injectable so tests exercise orchestration without wrangler. */
export type RunDeploy = (target: WorkerTarget, args: string[]) => Promise<string>;

/**
 * The UI build runner for one worker — injectable so tests exercise orchestration without a real build.
 *
 * `buildEnv` is not optional decoration, and it is a *set* of variables rather than one because the build
 * has to be told two different things by two different names — see {@link uiBuildEnvironment}.
 */
export type RunBuild = (
  target: WorkerTarget,
  command: string,
  args: string[],
  buildEnv: Readonly<Record<string, string>>,
) => Promise<void>;

/**
 * **What a front end's build has to be told, and why one variable was never enough (#579).**
 *
 * `ENVIRONMENT` is the name the deployed Worker answers to, and it is what `@pithy-sh/vite` resolves each
 * capability's client-safe projection against — a Turnstile sitekey differs per environment, and a build
 * that does not carry the deploy's `--env` inlines Cloudflare's always-passes test sitekey into a
 * production bundle. That much was already true.
 *
 * **`CLOUDFLARE_ENV` is the one that selects the wrangler stanza**, and nothing set it. It is what
 * `@cloudflare/vite-plugin` reads — `getEnvironmentVariableFactory({ variableName: "CLOUDFLARE_ENV" })`,
 * verified in 1.54.7 — so a build handed only `ENVIRONMENT` emitted the **top-level** stanza however
 * loudly `--env staging` was typed. The build output is then what `wrangler deploy` follows, through the
 * `.wrangler/deploy/config.json` redirect it writes, so the dev stanza is what shipped. Two variables,
 * two jobs; assuming one did both is the defect.
 *
 * **`CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` is how a feature environment reaches the build at all.** Its
 * ids are generated under `.wrangler/` rather than written into the tracked `wrangler.jsonc` (#242), so
 * the plugin has to be pointed at that file — and pointing it there is what lets the feature path stop
 * passing `--config` to wrangler. It had to: an explicit `--config` beats the redirect, and the source
 * config carries no `assets.directory`, so a feature deploy of a Worker with a front end failed outright.
 *
 * `dev` sets no `CLOUDFLARE_ENV`, because `dev` is the top-level stanza rather than an `env.dev` — see
 * `wranglerEnvironment`.
 */
export function uiBuildEnvironment(env: string | undefined, workerDir: string): Record<string, string> {
  if (env === undefined) return {};
  const overlay: Record<string, string> = { ENVIRONMENT: env };
  const stanza = wranglerEnvironment(env);
  if (stanza !== undefined) overlay.CLOUDFLARE_ENV = stanza;
  if (!isSourceEnvironment(env)) overlay.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = wranglerConfigPath(workerDir, env);
  return overlay;
}

export interface DeployProjectOptions {
  /** The project root — the parent of `apps/`, where every Worker lives. */
  projectDir: string;
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)` — or
   * `null` for a project that names none.
   *
   * **Required, and stated by the caller rather than defaulted.** An omitted account would resolve
   * whatever the last-loaded project happened to select, and the failure that produces is a successful
   * deploy to the wrong tenant. There is no safe default, so there is no default (#206).
   */
  account: CloudflareAccountSelection | null;
  /** Target environment; omitted deploys each worker's top-level config (no `--env`). */
  env?: string;
  /** Test seam: run one worker's deploy and return its captured stdout. Defaults to real wrangler. */
  runDeploy?: RunDeploy;
  /** Test seam: run one worker's UI build. Defaults to the real package-manager invocation. */
  runBuild?: RunBuild;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /**
   * The environment the build and `wrangler deploy` will inherit. Defaults to `process.env`, which is
   * what they actually inherit.
   *
   * **Here because `CLOUDFLARE_ENV` selects a wrangler stanza, and a shell can export it.** wrangler
   * resolves `args.env ?? CLOUDFLARE_ENV`, so the variable is a second input to what this command
   * publishes and the gate has to read the same one wrangler will. The seam exists so a suite states
   * that input rather than inheriting the developer's shell — a test asserting which stanza shipped
   * would otherwise pass or fail on what the operator happened to export.
   */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Test seam: probe a declared domain for the version just shipped. Defaults to the real HTTP probe.
   *
   * Injected rather than reached for, so the deploy tests never touch the network and the retry/backoff
   * behavior is exercised without waiting for it.
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
   * resolve a domain for, and a Worker that declares no address has no domain to probe. `mismatch` and
   * `unreachable` are the two that fail the command — see `isDeployFailure`.
   */
  verification?: DeployVerification;
  /** The one-line explanation behind `verification`, for the summary and the `--json` row. */
  verificationDetail?: string;
}

/**
 * What a scraped token cannot end with.
 *
 * **This is a scrape of another tool's prose, and the trimming is the half that makes it usable.**
 * `\S+` runs to the next space, so an address wrangler wrapped in quotes or brackets came back
 * wearing them — `https://staging.app.pithy.sh")` was printed as the place a Worker had been
 * deployed, and it is an address that reaches nothing when copied or clicked.
 *
 * Closing punctuation only. An opening bracket cannot end a URL either, but it also cannot be what a
 * greedy match picked up: whatever precedes the address is not inside the match.
 */
const TRAILING_PUNCTUATION = /[)\]}>"'.,;:]+$/;

/**
 * What a scraped token cannot begin with.
 *
 * Only the version id can pick one up: the URL pattern starts matching at `https`, so nothing before
 * the address is inside it. `Version ID: "7908726e".` is the shape — captured by `(\S+)`, quote and
 * all, which is how the first version of this fix left one behind.
 */
const LEADING_PUNCTUATION = /^["'([{<]+/;

/**
 * One scraped token, without the punctuation the surrounding sentence put on it.
 *
 * **Balanced brackets are kept.** A URL may legally end in `)` — a path ending in one, which is rare
 * and real — so a trailing bracket is dropped only when the token holds no opener to match it. The
 * unbalanced case is the one wrangler's own formatting creates, and the balanced case is somebody's
 * actual address.
 */
function trimmed(token: string): string {
  const opened = token.replace(LEADING_PUNCTUATION, "");
  const cut = opened.replace(TRAILING_PUNCTUATION, "");
  const dropped = opened.slice(cut.length);
  if (dropped === "") return opened;
  // Give back any closer the token itself opened, innermost last, so `…/a(b)` survives and `…/a)`
  // does not. Only brackets can be balanced; a quote or a full stop is never part of the address.
  let restored = cut;
  for (const character of dropped) {
    const opener = { ")": "(", "]": "[", "}": "{" }[character];
    if (opener === undefined) break;
    const opens = restored.split(opener).length - 1;
    const closes = restored.split(character).length - 1;
    if (opens <= closes) break;
    restored += character;
  }
  return restored;
}

/**
 * Scrape the version id and public url from `wrangler deploy` output — best-effort, both optional.
 *
 * **Neither is a contract.** Wrangler is free to reword this output in any release, and these two
 * patterns are the whole of what reads it. Finding nothing is an ordinary outcome: the summary line
 * prints without the detail and the deploy is unaffected, which is why nothing here throws.
 */
function parseDeployOutput(stdout: string): { versionId?: string; url?: string } {
  const summary: { versionId?: string; url?: string } = {};
  const version = stdout.match(/Version ID:\s*(\S+)/);
  if (version?.[1]) summary.versionId = trimmed(version[1]);
  // The deployed URL is the last one wrangler prints (after upload), not an earlier docs/dashboard link.
  const urls = stdout.match(/https?:\/\/\S+/g);
  const last = urls?.[urls.length - 1];
  if (last) summary.url = trimmed(last);
  return summary;
}

/** The scrape, for the test that holds it to the shapes wrangler actually prints. */
export const deployOutput = { parse: parseDeployOutput };

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
 * The default deploy step: `wrangler deploy [--env <env>] --experimental-provision=false` in the worker's directory, quiet on
 * success (its output is captured and summarized, not streamed — the brand voice). Wrangler reads
 * `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, so CI needs no interactive login; we also pass them
 * from the project's own credentials file so a local deploy authenticates the same way.
 *
 * **The account is an argument, and that is load-bearing here more than anywhere.** This is the exact
 * pair handed to `wrangler deploy`: resolving it against the wrong account does not fail, it ships to
 * another company's tenant and exits 0. A pinned `accountId` that disagrees refuses before wrangler is
 * ever spawned (#206).
 *
 * **The four lines that used to build that pair here now live in `cloudflareChildEnv`, once (#555).**
 * They were right here and right in `hostDeploy` and absent in `pithy dev`, which is what a rule kept
 * at call sites costs. The account is still the argument; only the assembly moved.
 *
 * **The resolution still happens here, before the batch, and that is not redundant with the one inside
 * `runWrangler`.** `deployProject` deliberately does not abort on a single worker's failure, so a
 * mismatch discovered per spawn would be reported as every worker failing rather than as the one
 * configuration fault it is — the shape #236 records for whole-project facts consulted per item.
 * Resolving once at construction keeps #206's refusal a refusal.
 */
function defaultRunDeploy(account: CloudflareAccountSelection | null): RunDeploy {
  cloudflareEnv({ account });
  return async (target, args) => {
    // `runWrangler` refuses an argv that leaves provisioning on, whatever name it is called by (#589).
    const { stdout } = await runWrangler(args, { account, cwd: target.dir });
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
const defaultRunBuild: RunBuild = async (target, command, args, buildEnv) => {
  try {
    await runProcess(command, args, {
      cwd: target.dir,
      maxBuffer: 16 * 1024 * 1024,
      // Overlaid on the real environment rather than replacing it: a build needs PATH, and CI needs
      // whatever else it exported. What each name does is {@link uiBuildEnvironment}'s sentence to say.
      env: { ...process.env, ...buildEnv },
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

  // Through the one stanza reader, never the tracked file directly (#643): a feature's stanza is in the
  // generated config that was just deployed, and a top-level `workers_dev` wrangler inherits is read with it.
  // Offline — a feature's address is the one provisioning stamped, so verifying asks the account nothing.
  const stanza = await readAddressStanza(worker.dir, env);

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

  const run = options.runDeploy ?? defaultRunDeploy(options.account);
  const build = options.runBuild ?? defaultRunBuild;
  const packageManager = await detectPackageManager(options.projectDir);
  // **`--config` for a feature environment, and only where nothing has already built one.** Provisioning
  // writes a feature's ids into a generated config under `.wrangler/` rather than into the tracked
  // `wrangler.jsonc` (#242), so wrangler has to be told where they are. A declared environment's ids are
  // in the file wrangler already reads.
  //
  // **Not for a Worker with a front end, and that reverses what this line used to do (#579).** An
  // explicit `--config` beats the `.wrangler/deploy/config.json` redirect — measured — and the source
  // config carries no `assets.directory`, because only the build writes one. So a feature deploy of a UI
  // Worker failed on exactly that, every time. The build is pointed at the generated config instead
  // (`uiBuildEnvironment`), which puts the feature's ids *and* the asset wiring in one file, and the
  // redirect hands wrangler that file.
  const configFor = (worker: WorkerTarget, hasUi: boolean): string[] =>
    options.env && !isSourceEnvironment(options.env) && !hasUi
      ? ["--config", wranglerConfigPath(worker.dir, options.env)]
      : [];
  // Through `wranglerEnvironment`, so the argv, the build and the gate cannot disagree about which stanza
  // is being asked for — and so `dev`, which is the top-level stanza rather than an `env.dev`, does not
  // ask wrangler for an environment that no project is allowed to declare.
  const stanza = wranglerEnvironment(options.env);
  // **And it creates nothing (#589).** wrangler's default for a deploy is to create any resource a binding
  // names and it cannot find, so a stanza with a `database_name` and no id made a database. Provisioning
  // is `pithy provision`'s reviewed step; see `NO_PROVISION_ARG` for why the argv is the only place to say so.
  const args = stanza ? ["deploy", "--env", stanza, NO_PROVISION_ARG] : ["deploy", NO_PROVISION_ARG];
  const audit = options.audit ?? (async () => {});
  const probe = options.verifyDeploy ?? ((probeOptions) => verifyDeployedVersion(probeOptions));
  const severity = deploySeverity(options.env);

  const deploys: WorkerDeploy[] = [];
  for (const worker of workers) {
    // **What this run is on, said before it starts rather than after it ends (#578).** Everything below
    // is captured on purpose — the build's chunk table and wrangler's upload chatter are summarized, not
    // streamed — and capturing them removed the only evidence the command was alive. One Worker can hold
    // this line for minutes, which is the point: a slow upload and a hung one are otherwise the same
    // blank terminal, and the remedy an operator reaches for is Ctrl-C mid-deploy.
    startStep(worker.name);
    // Stays undefined for an API-only worker, turns false while a UI worker's build is in flight: a
    // `built: false` row is how a `--json` consumer reads "the build failed, the deploy never ran".
    let built: boolean | undefined;
    // Which step a failure belongs to, stated rather than inferred from `built` — the refusal below is a
    // third step, and it happens after a successful build and before any upload.
    let stage: "build" | "config" | "deploy" = "deploy";
    try {
      const ui = await uiBuild(worker, packageManager);
      if (ui) {
        stage = "build";
        built = false;
        await build(worker, ui.command, ui.args, uiBuildEnvironment(options.env, worker.dir));
        built = true;
      }
      const argv = [...args, ...configFor(worker, ui !== undefined)];
      // **The last moment this is still recoverable.** The configuration wrangler is about to read is a
      // file on disk now, and what it deploys as is written in it — so it is asked, and a deploy that
      // would publish something other than the requested environment refuses instead (#579). After the
      // upload the only remedy is deleting a live Worker.
      stage = "config";
      // Asked of the exact argv about to be spawned, before the config gate reads a file, so a lost switch is
      // this sentence on the Worker's row. The seam asks it again and is what cannot be walked around (#589).
      assertCreatesNoResources(argv);
      await assertDeploysRequestedEnvironment({
        workerDir: worker.dir,
        env: options.env,
        args: argv,
        processEnv: options.processEnv ?? process.env,
      });
      stage = "deploy";
      const stdout = await run(worker, argv);
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
      // The summary line, streamed as it settles rather than held to the end (#578). It **moves**: the
      // command no longer prints it a second time, because two copies of one sentence drift the first
      // time either is reworded, and an operator comparing them has no way to tell a rewording from a
      // different Worker.
      settleStep(summarizeDeploy(deploy));
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
      const failure: WorkerDeploy = {
        name: worker.name,
        ok: false,
        ...(built === undefined ? {} : { built }),
        error: reason,
      };
      deploys.push(failure);
      // A failure settles too. The one thing worse than a silent deploy is a silent deploy whose one
      // broken Worker is reported after every other upload has finished.
      settleStep(summarizeDeploy(failure));
      // A failed deploy is exactly what an audit trail is for — record it too, not just successes.
      await audit({
        action: "deploy/worker_deployed",
        outcome: "failure",
        severity,
        resourceType: "cf_worker",
        resourceId: worker.name,
        // Same as the success path: `worker` is `resourceId` and `env` is the `environment` column.
        // What stays is what is genuinely per-event — which stage failed, and why.
        metadata: { stage, error: reason },
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
  // Wrangler's own URL keeps appearing here, as it always did — it tells a human where their deploy
  // went. The verification line below is the separate question of whether the *declared* address is now
  // serving what was just shipped, and it is the only one that can fail the command.
  if (!deploy.verification || deploy.verification === "verified") {
    return detail ? `${deploy.name}: deployed. ${detail}` : `${deploy.name}: deployed.`;
  }
  const note = deploy.verificationDetail ?? "";
  // **A verification that fails the command reads as a failure, not as a note under a success (#579).**
  // `deployed.` followed by an indented hint is how "nothing answers at the address this project claims"
  // was reported while a dev-composed Worker sat on a public URL — the operator was told to check a
  // route. The upload did happen, and the line still says so, but the headline is the fact that failed.
  // One rule, `isDeployFailure`, decides that and the exit code, so they can never disagree.
  if (!isDeployFailure(deploy.verification)) {
    const line = detail ? `${deploy.name}: deployed. ${detail}` : `${deploy.name}: deployed.`;
    return `${line}\n  ${note}`;
  }
  const failed = red(`${deploy.name}: deployed, and not verified.`);
  return `${detail ? `${failed} ${detail}` : failed}\n  ${red(note)}`;
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
