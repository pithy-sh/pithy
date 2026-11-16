// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { commandName, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { InternalError, messageOf, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { PrivacyAttestation } from "@pithy-sh/core/src/privacy/posture";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { inShadow } from "../plan/shadow";
import { execCommand } from "../platform/command";
import { privacyVarArgs } from "../privacy/deployGate";
import {
  bundleStampVerdict,
  type ReadWorkerVars,
  readDeployedStamp,
  recordDeployStamp,
  UNFINISHED_STAMP,
  type WriteWorkerVar,
} from "../provision/deployStamp";
import { isSourceEnvironment, wranglerConfigPath } from "../provision/featureConfig";
import { EXIT, exitCodeOf } from "../terminal/exitClass";
import { settleStep, startStep } from "../terminal/progress";
import { red } from "../terminal/style";
import { type AppBundle, appBundleStamp, bundleArgs, shadowBundlePaths, stampArgs } from "./appBundleStamp";
import { loadWorkerConfig, loadWorkerDomains, type WorkerConfig } from "./config";
import {
  assertCreatesNoResources,
  assertDeploysRequestedEnvironment,
  NO_PROVISION_ARG,
  wranglerEnvironment,
} from "./effectiveConfig";
import { detectPackageManager, execArgs, type PackageManager } from "./packageManager";
import { dependencyOrder } from "./serviceGraph";
import { type RetryWait, withUnseenWorkerRetry } from "./unseenWorkerRetry";
import type { DeployVerification, VerifyDeployResult } from "./verifyDeploy";
import { isDeployFailure, verifyDeployedVersion } from "./verifyDeploy";
import { readAddressStanza, resolveWorkerAddress } from "./workerAddress";
import { readServiceProject } from "./workerBind";
import { parseWorkerManifest } from "./workerManifest";
import { discoverWorkers, type WorkerTarget } from "./workers";
import { refusesTheRun, runWrangler } from "./wrangler";

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
 * **What a front end's build has to be told: two variables, two jobs.**
 *
 * `ENVIRONMENT` is the name the deployed Worker answers to, and what `@pithy-sh/vite` resolves each
 * capability's client-safe projection against: a build without it inlines Cloudflare's always-passes test
 * Turnstile sitekey into a production bundle.
 *
 * `CLOUDFLARE_ENV` selects the wrangler stanza. `@cloudflare/vite-plugin` reads it and nothing else, and the
 * `.wrangler/deploy/config.json` redirect it writes is what `wrangler deploy` follows, so a build without it
 * ships the top-level stanza whatever `--env` said.
 *
 * `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` points the plugin at a feature environment's generated config under
 * `.wrangler/`, which is how the feature's ids and the asset wiring reach one file without a `--config`.
 *
 * `dev` sets no `CLOUDFLARE_ENV`: it is the top-level stanza rather than an `env.dev` (see `wranglerEnvironment`).
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
   * deploy to the wrong tenant. There is no safe default, so there is no default.
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
  /**
   * **`pithy deploy --dry-run`.** Every Worker is built as the deploy builds it and bundled by `wrangler deploy
   * --dry-run` on the deploy's own argv, so a bundle that does not build fails its row here, and its stamp is
   * read and compared exactly as the deploy compares it. Nothing is uploaded, probed or audited. Both happen in
   * a private copy of the project, so neither the build's output nor the bundle is written here.
   */
  dryRun?: boolean;
  /**
   * **What this deploy attests about privacy**, from `deployPrivacy` — the declared classes and the
   * console gate's verdict. Carried into every Worker as the `PITHY_PRIVACY` var on wrangler's argv, which a
   * raw `wrangler deploy` does not repeat, so a Worker shipped around this command reads as unattested rather
   * than as whatever was last true. Omitted, no var is passed.
   */
  privacy?: PrivacyAttestation;
  /**
   * Read a deployed Worker's vars, for its stamp. Omitted, nothing is known and every Worker deploys: the caller
   * builds it from the project's account, so a suite never reaches one.
   */
  readVars?: ReadWorkerVars;
  /**
   * Record a Worker's stamp once its deploy and verification have passed. Omitted, none is recorded and the next
   * run deploys again: the caller builds it from the project's account, as it does the reader.
   */
  writeVar?: WriteWorkerVar;
  /** `--force`: upload a Worker whose stamp matches, and read nothing. */
  force?: boolean;
  /** How the one retry of an unseen Worker waits. Defaults to a real timer; a test states it. */
  retryWait?: RetryWait;
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
  /** Whether `wrangler deploy` succeeded for this worker. An unchanged Worker is `ok`. */
  ok: boolean;
  /**
   * `deployed` when wrangler uploaded it, `unchanged` when its live stamp matched and nothing ran. Under
   * `--dry-run`, what the deploy would do. Absent on a failure.
   */
  outcome?: "deployed" | "unchanged";
  /** Why the outcome is what it is, in one sentence. Absent on a failure. */
  reason?: string;
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
   * The exit a classified failure carries: 3 when Cloudflare refused the credentials or wrangler would not start,
   * met after an earlier Worker already had a row. Absent on an ordinary failure, which exits 1.
   */
  exit?: number;
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
 * What a wrangler target has to look like to be a host.
 *
 * Dotted labels and nothing else. A target that is not an address is a sentence (`Producer for
 * emails`), a prefixed value (`schedule: <cron>`, `workflow: Onboarding`) or a count (`event
 * triggers: 2`), and none of those survives this. A wildcard route — `*.acme.com` with any path — is
 * rejected on purpose: it names a shape of host rather than a host, so there is no address to report.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * One target from wrangler's triggers block as an address, or nothing when it is not one.
 *
 * **Everything under that heading is a trigger, and only some triggers are addresses.** The block
 * carries crons, queue producers and consumers, workflows and an event-trigger count beside the
 * routes, so a target is accepted only when it is a URL wrangler already wrote a scheme on — it does
 * that for `workers.dev` and for nothing else — or a bare host.
 *
 * **A custom domain or a route arrives scheme-less and annotated.** Wrangler prints
 * `staging.app.pithy.sh (custom domain - zone name: pithy.sh)`, and a route adds the path it matches:
 * `api.acme.com/v1/*`. The first whitespace-delimited token drops the annotation, the host is what
 * precedes the path, and `https://` is the scheme — a Cloudflare custom domain or proxied route is
 * always TLS. So a path-scoped route reports the host that answers for the Worker rather than the
 * pattern the route matched, which is the one inference here wrangler did not itself assert.
 */
function workerAddress(target: string): string | undefined {
  const token = trimmed(target.trim().split(/\s+/, 1)[0] ?? "");
  if (/^https?:\/\//i.test(token)) return token;
  const host = token.split("/")[0] ?? "";
  return HOSTNAME.test(host) ? `https://${host}` : undefined;
}

/**
 * The Worker's address out of `wrangler deploy`'s own triggers block, or nothing.
 *
 * Anchored on wrangler's label, never the last URL in stdout: `wrangler deploy` prints a telemetry notice
 * after the summary, once per wrangler version per machine, and its documentation link is not an address.
 *
 * Wrangler prints `Deployed <name> triggers (<time>)` and then every target indented beneath it, so
 * the block is that heading and the indented lines under it. The first target that is an address
 * wins, and the first un-indented line ends the block — which is what keeps `Current Version ID:`
 * and everything printed after it, the notice included, out of the answer.
 */
function deployedAddress(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  const heading = lines.findIndex((line) => /^Deployed .+ triggers\b/.test(line));
  if (heading === -1) return undefined;
  for (const line of lines.slice(heading + 1)) {
    if (!/^\s+\S/.test(line)) return undefined;
    const address = workerAddress(line);
    if (address !== undefined) return address;
  }
  return undefined;
}

/**
 * Scrape the version id and public url from `wrangler deploy` output — best-effort, both optional.
 *
 * **Neither is a contract.** Wrangler is free to reword this output in any release, and these two
 * patterns are the whole of what reads it. Finding nothing is an ordinary outcome: the summary line
 * prints without the detail and the deploy is unaffected, which is why nothing here throws. A
 * confidently wrong answer is not an ordinary outcome, so each pattern is anchored on wrangler's label.
 */
function parseDeployOutput(stdout: string): { versionId?: string; url?: string } {
  const summary: { versionId?: string; url?: string } = {};
  const version = stdout.match(/Version ID:\s*(\S+)/);
  if (version?.[1]) summary.versionId = trimmed(version[1]);
  const url = deployedAddress(stdout);
  if (url !== undefined) summary.url = url;
  return summary;
}

/**
 * The scrape, for the test that holds it to the shapes wrangler actually prints.
 *
 * `address` is the per-target decision, exposed beside `parse` because that is where the judgment
 * about what counts as an address lives — a cron and a custom domain are told apart one target at a
 * time, and testing it through a whole stdout only says which target won.
 */
export const deployOutput = { parse: parseDeployOutput, address: workerAddress };

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
 * **The account is an argument.** This is the exact pair handed to `wrangler deploy`: resolving it against the
 * wrong account does not fail, it ships to another company's tenant and exits 0. `runWrangler` builds the
 * child's environment through `cloudflareChildEnv`.
 *
 * **It is resolved here, once, before the batch.** `deployProject` does not abort on a single Worker's failure,
 * so a pin the credentials contradict, discovered per spawn, would read as every Worker failing rather than as
 * the one configuration fault it is.
 */
function defaultRunDeploy(account: CloudflareAccountSelection | null): RunDeploy {
  cloudflareEnv({ account });
  return async (target, args) => {
    const { stdout } = await runWrangler(args, { account, cwd: target.dir });
    return stdout;
  };
}

/**
 * The default UI build step: the worker's `ui.build` argv, through the project's package manager, in the
 * worker's own directory. Quiet on success like the deploy step — the output is captured and surfaced only
 * as the failure `detail`. A build's chunk table can be long, so the buffer is generous; truncation would
 * turn a real failure into a confusing one.
 */
const defaultRunBuild: RunBuild = async (target, command, args, buildEnv) => {
  try {
    await execCommand(command, args, {
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
      // The child's captured output, without its color: it becomes the row's `error`.
      detail: stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause)),
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
 * Probe one Worker's declared domain for the version just shipped, or return null when there is nothing
 * to check.
 *
 * Three ways to have nothing to check, and all three are ordinary rather than failures. **No `--env`**:
 * a bare `pithy deploy` ships each Worker's top-level stanza, which is the `dev` environment, and `dev`
 * has no public address by design. **No version id**: wrangler printed none, so there is nothing to
 * correlate against. **No declared address**: the Worker has no domain, no route, and no `BASE_URL`, so
 * there is nowhere to probe — and `workers.dev` is never assumed, since the subdomain can be disabled per
 * account and commonly is in production.
 */
async function verifyWorkerDeploy(
  worker: WorkerTarget,
  env: string | undefined,
  versionId: string | undefined,
  probe: VerifyDeploy,
): Promise<VerifyDeployResult | null> {
  if (!env || env === "dev" || !versionId) return null;

  // The load may fail for a reason this reader forgives; a refused declaration is not one.
  let config: WorkerConfig | undefined;
  try {
    config = await loadWorkerConfig(worker.dir);
  } catch {
    config = undefined;
  }
  const domains = config === undefined ? undefined : loadWorkerDomains(config);

  // Through the one stanza reader, never the tracked file directly: a feature's stanza is in the
  // generated config that was just deployed, and a top-level `workers_dev` wrangler inherits is read with it.
  // Offline — a feature's address is the one provisioning stamped, so verifying asks the account nothing.
  const stanza = await readAddressStanza(worker.dir, env);

  const address = resolveWorkerAddress({ environment: env, domains, stanza });
  if (!address) return null;

  return probe({ url: address.url, expectedVersion: versionId });
}

/**
 * The Workers in the order they can ship in: each one after every Worker its app binds. Read from the same
 * declarations `pithy worker bind` writes; a Worker whose config will not load keeps its place, and so does
 * every Worker of a project with no bindings at all.
 */
async function inBindingOrder(projectDir: string, workers: readonly WorkerTarget[]): Promise<WorkerTarget[]> {
  const { edges } = await readServiceProject({ projectDir, discoverWorkers: async () => [...workers] });
  const byApp = new Map(workers.map((worker) => [basename(worker.dir), worker]));
  return dependencyOrder([...byApp.keys()], edges).flatMap((app) => {
    const worker = byApp.get(app);
    return worker ? [worker] : [];
  });
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
 *
 * A Worker whose bundle and resolved configuration are already live is `unchanged`, and wrangler uploads
 * nothing for it; `force` uploads it anyway.
 */
export async function deployProject(options: DeployProjectOptions): Promise<WorkerDeploy[]> {
  // Only real Workers deploy. A non-Worker process in the dev set (a Vite frontend with a
  // `pithy.worker.jsonc` but no `wrangler.jsonc`) has nothing for `wrangler deploy` to ship.
  const discovered = (await discoverWorkers(options.projectDir)).filter((worker) => worker.hasWrangler !== false);
  // Every service binding's target first: an upload binding a script that does not exist is refused.
  const workers = await inBindingOrder(options.projectDir, discovered);
  if (workers.length === 0) {
    throw new NotFoundError({
      message: "No deployable workers here.",
      action: `Every worker lives in apps/<name> with its own wrangler.jsonc. Name one and create it with ${commandName("worker add")}.`,
    });
  }

  if (!options.dryRun) return deployWorkers(options, workers, { toProject: (text) => text });
  // **`--dry-run` builds and bundles in a private copy of the project.** The build writes its output and whatever
  // its hooks write, and wrangler bundles under `.wrangler/tmp`, so in the project a plan that promised to write
  // nothing would have written all of it. In the copy each Worker builds from the same source and the same
  // installed packages, through a linked `node_modules`, and the copy is gone afterwards. Not exactly as here: no
  // `.env` or `.dev.vars` is copied, and a build that keeps a cache in `node_modules` writes it
  // (`docs/commands/deploy.md` says both). A failure names the project's paths, and the stamp is taken over the
  // project's paths, so the verdict is the one the deploy reaches.
  const { result } = await inShadow(
    options.projectDir,
    (shadow) =>
      deployWorkers(
        { ...options, projectDir: shadow.root },
        workers.map((worker) => ({ ...worker, dir: shadow.at(worker.dir) })),
        {
          toProject: shadow.toProject,
          bundlePaths: (workerDir) => shadowBundlePaths(shadow, options.projectDir, workerDir),
        },
      ),
    { plan: false },
  );
  return result;
}

/** How a row and a stamp are put back in the project's terms when the Workers were built in a copy. */
interface ProjectPaths {
  /** The copy's paths back to the project's, in what a row reports. */
  toProject: (text: string) => string;
  /** The normalizer a Worker's bundle is hashed through. Absent, the bundle is the project's own. */
  bundlePaths?: (workerDir: string) => Promise<(text: string) => string>;
}

/**
 * Bundle one Worker as the deploy's argv would, into a directory of its own, and stamp what wrangler wrote.
 * Under `--dry-run` this is the dry run: wrangler bundles, validates, and uploads nothing.
 */
async function bundleWorker(
  run: RunDeploy,
  worker: WorkerTarget,
  argv: readonly string[],
  processEnv: NodeJS.ProcessEnv,
  paths: ProjectPaths,
): Promise<AppBundle> {
  const outdir = await mkdtemp(join(tmpdir(), "pithy-bundle-"));
  try {
    await run(worker, [...argv, ...bundleArgs(outdir)]);
    const normalize = paths.bundlePaths ? await paths.bundlePaths(worker.dir) : undefined;
    return await appBundleStamp({ workerDir: worker.dir, args: argv, processEnv, outdir, normalize });
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}

/**
 * Build, bundle and deploy each Worker in turn: under `--dry-run`, each one in the copy {@link deployProject}
 * made, stopping at the verdict.
 *
 * A Worker is uploaded only when its bundle and resolved configuration hash to something other than the stamp
 * it carries. The upload carries `unfinished` in the stamp's place, and the stamp is recorded only after wrangler
 * has returned and the declared address has not failed its check: wrangler sets triggers after the upload, so a
 * deploy can fail with its code live, and the marker is what sends the next run to deploy and verify again. A
 * first deploy Cloudflare has not propagated yet is run once more.
 */
async function deployWorkers(
  options: DeployProjectOptions,
  workers: readonly WorkerTarget[],
  paths: ProjectPaths,
): Promise<WorkerDeploy[]> {
  const run = options.runDeploy ?? defaultRunDeploy(options.account);
  const build = options.runBuild ?? defaultRunBuild;
  const packageManager = await detectPackageManager(options.projectDir);
  const processEnv = options.processEnv ?? process.env;
  // `--config` for a feature environment, whose ids live in a generated config under `.wrangler/` — but not for
  // a Worker with a front end. An explicit `--config` beats the build's `.wrangler/deploy/config.json` redirect,
  // and the source config carries no `assets.directory`; the build is pointed at the generated config instead
  // (`uiBuildEnvironment`), and the redirect hands wrangler that file.
  const configFor = (worker: WorkerTarget, hasUi: boolean): string[] =>
    options.env && !isSourceEnvironment(options.env) && !hasUi
      ? ["--config", wranglerConfigPath(worker.dir, options.env)]
      : [];
  // Through `wranglerEnvironment`, so the argv, the build and the gate agree about which stanza is asked for,
  // and `dev`, the top-level stanza, asks for no environment.
  const stanza = wranglerEnvironment(options.env);
  // And it creates nothing: wrangler's default creates any resource a binding names and cannot find.
  // Provisioning is `pithy provision`'s step.
  const args = [
    ...(stanza ? ["deploy", "--env", stanza, NO_PROVISION_ARG] : ["deploy", NO_PROVISION_ARG]),
    ...(options.privacy ? privacyVarArgs(options.privacy) : []),
  ];
  const audit = options.audit ?? (async () => {});
  const probe = options.verifyDeploy ?? ((probeOptions) => verifyDeployedVersion(probeOptions));
  const severity = deploySeverity(options.env);

  const deploys: WorkerDeploy[] = [];
  for (const worker of workers) {
    // Said before the work starts: everything below is captured rather than streamed, and one Worker can hold
    // this line for minutes.
    startStep(worker.name);
    // Undefined for an API-only worker, false while a UI worker's build is in flight: a `built: false` row is how
    // a `--json` consumer reads "the build failed, the deploy never ran".
    let built: boolean | undefined;
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
      // The last moment this is still recoverable: the configuration wrangler is about to read is on disk, and a
      // deploy that would publish something other than the requested environment refuses here. Asked of the
      // exact argv about to be spawned.
      stage = "config";
      assertCreatesNoResources(argv);
      await assertDeploysRequestedEnvironment({ workerDir: worker.dir, env: options.env, args: argv, processEnv });
      stage = "deploy";
      const bundle = await bundleWorker(run, worker, argv, processEnv, paths);
      const scriptName = bundle.scriptName ?? worker.name;
      const verdict = bundleStampVerdict({
        current: bundle.stamp,
        force: options.force,
        // Under `--force` nothing a read could say would change the answer.
        deployed: options.force ? { state: "absent" } : await readDeployedStamp(options.readVars, scriptName),
      });
      const decided = {
        name: worker.name,
        ok: true,
        ...(built === undefined ? {} : { built }),
        outcome: verdict.deploy ? ("deployed" as const) : ("unchanged" as const),
        reason: verdict.reason,
      };
      if (options.dryRun) {
        deploys.push(decided);
        settleStep(summarizePlannedDeploy(decided), { worker: decided });
        continue;
      }
      if (!verdict.deploy) {
        deploys.push(decided);
        settleStep(summarizeDeploy(decided), { worker: decided });
        continue;
      }
      const stdout = await withUnseenWorkerRetry(
        scriptName,
        () => run(worker, [...argv, ...stampArgs(UNFINISHED_STAMP)]),
        options.retryWait,
      );
      const deploy: WorkerDeploy = { ...decided, ...parseDeployOutput(stdout) };
      // Prove the Worker just shipped is the one answering at the address this project claims. Not a liveness
      // probe: the old version answering happily is exactly the failure worth catching.
      const verified = await verifyWorkerDeploy(worker, options.env, deploy.versionId, probe);
      if (verified) {
        deploy.verification = verified.status;
        deploy.verificationDetail = verified.detail;
      }
      if (!verified || !isDeployFailure(verified.status)) {
        const note = await recordDeployStamp(options.writeVar, scriptName, bundle.stamp);
        if (note) deploy.reason = `${deploy.reason} ${note}`;
      }
      deploys.push(deploy);
      settleStep(summarizeDeploy(deploy), { worker: deploy });
      await audit({
        action: "deploy/worker_deployed",
        outcome: "success",
        severity,
        resourceType: "cf_worker",
        resourceId: worker.name,
        // The environment is the `environment` column the recorder stamps, and the Worker is `resourceId`.
        metadata: { versionId: deploy.versionId ?? null, verification: deploy.verification ?? null },
      });
    } catch (error) {
      // Credentials Cloudflare refused, or a wrangler that will not start, are the run's on the first Worker:
      // every Worker after it asks with the same pair and the same program, so it is thrown and exits 3. Once
      // any Worker has a row, a throw would lose that row, so the refusal is this Worker's row, carrying its exit.
      const refusal = refusesTheRun(error);
      if (refusal && deploys.length === 0) throw error;
      const reason = paths.toProject(reasonOf(error));
      const failure: WorkerDeploy = {
        name: worker.name,
        ok: false,
        ...(built === undefined ? {} : { built }),
        error: reason,
        ...(refusal ? { exit: exitCodeOf(error.payload) } : {}),
      };
      deploys.push(failure);
      settleStep(summarizeDeploy(failure), { worker: failure });
      // A dry run deployed nothing, so there is no deploy to record, failed or not.
      if (options.dryRun) continue;
      await audit({
        action: "deploy/worker_deployed",
        outcome: "failure",
        severity,
        resourceType: "cf_worker",
        resourceId: worker.name,
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
  if (deploy.outcome === "unchanged") return `${deploy.name}: unchanged. ${deploy.reason ?? ""}`.trimEnd();
  const detail = [deploy.url, deploy.versionId].filter(Boolean).join(" ");
  // Wrangler's own URL keeps appearing here, as it always did — it tells a human where their deploy
  // went. The verification line below is the separate question of whether the *declared* address is now
  // serving what was just shipped, and it is the only one that can fail the command.
  if (!deploy.verification || deploy.verification === "verified") {
    return detail ? `${deploy.name}: deployed. ${detail}` : `${deploy.name}: deployed.`;
  }
  const note = deploy.verificationDetail ?? "";
  // A verification that fails the command reads as a failure, not as a note under a success: the upload did
  // happen, and the line says so, but the headline is the fact that failed. `isDeployFailure` decides this
  // and the exit code, so they cannot disagree.
  if (!isDeployFailure(deploy.verification)) {
    const line = detail ? `${deploy.name}: deployed. ${detail}` : `${deploy.name}: deployed.`;
    return `${line}\n  ${note}`;
  }
  const failed = red(`${deploy.name}: deployed, and not verified.`);
  return `${detail ? `${failed} ${detail}` : failed}\n  ${red(note)}`;
}

/**
 * One Worker's line under `--dry-run`: what the deploy would do. A failure and an unchanged Worker read exactly
 * as the real run's, because each is the same outcome met before the upload.
 */
export function summarizePlannedDeploy(deploy: WorkerDeploy): string {
  if (!deploy.ok || deploy.outcome === "unchanged") return summarizeDeploy(deploy);
  const line = deploy.built ? `${deploy.name}: built, and would deploy.` : `${deploy.name}: would deploy.`;
  return deploy.reason ? `${line} ${deploy.reason}` : line;
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
  return `${pending} migration${plural} unapplied for ${env}. Deploy does not migrate — run ${pithyCommand("migrate", { flags: { "--env": env } })}.`;
}

/**
 * The exit a report with a failed Worker ends with: the class a classified row carries, or 1. A refusal recorded as
 * a row is the run's precondition, and nothing after it can succeed until it is met, so it outranks an ordinary
 * failure beside it — the caller's next step is the credentials, whatever else failed.
 */
export function deployFailureExit(deploys: readonly WorkerDeploy[]): number {
  return deploys.find((deploy) => !deploy.ok && deploy.exit !== undefined)?.exit ?? EXIT.failed;
}
