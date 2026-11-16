// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import {
  assertCreatesNoResources,
  assertPublishesDeclaredWorker,
  NO_PROVISION_ARG,
  TOP_LEVEL_STANZA_ARG,
} from "../project/effectiveConfig";
import { kitImport } from "../project/kitResolve";
import { type RetryWait, withUnseenWorkerRetry } from "../project/unseenWorkerRetry";
import { runWrangler, type WranglerAccount } from "../project/wrangler";
import {
  deployStamp,
  type ReadWorkerVars,
  readDeployedStamp,
  recordDeployStamp,
  stampConfig,
  stampVerdict,
  UNFINISHED_STAMP,
  type WriteWorkerVar,
} from "../provision/deployStamp";
import { startStep } from "../terminal/progress";
import { hostConfigFile, hostEntryFile } from "./hostFiles";

/**
 * **The one path a kit Worker is deployed through, and therefore the one place its gate lives.**
 *
 * Every capability provisioner and `pithy deploy --kit` call {@link deployHostWorker}, so each inherits the
 * comparison against what is live with no flag: on a first provision there is no stamp, so it deploys. There
 * is no `--if-changed`, because a flag that can only ever be true is one somebody leaves off believing it
 * does something.
 *
 * **A provisioner takes no `force`.** `pithy <capability> provision` creates account resources, and a run
 * whose only purpose is to re-upload an unchanged Worker should not also touch buckets, namespaces and Email
 * Routing rules. The re-upload is `pithy deploy --env <env> --kit --force`, which creates nothing and ships
 * the same config the provisioner would.
 *
 * **The adopter's own Workers are gated too, by `project/deploy.ts`.** A kit Worker's stamp is its package
 * version and config hash, because its entry is inside `node_modules`; an app Worker's is a hash of the
 * bundle wrangler would upload and its resolved configuration. Both upload `unfinished` in its place, record
 * the stamp through `recordDeployStamp` once the deploy has finished, read it back through
 * `readDeployedStamp`, and retry a first deploy Cloudflare has not propagated yet.
 */

/** What one gated deploy did, and why. The `--json` row and the terminal line both read from this. */
export interface HostDeployOutcome {
  /** The capability that owns the Worker — `email`. */
  capability: string;
  /** The deployed script name, e.g. `acme-prod-email`. */
  worker: string;
  /** Whether wrangler ran. `unchanged` is the skip. */
  outcome: "deployed" | "unchanged";
  /** One sentence saying why. Never empty — a skip nobody can explain is the failure mode. */
  reason: string;
}

/**
 * Ship one resolved config. The seam tests replace so nothing here spawns wrangler.
 *
 * It takes the argv, not the config path: the stanza a deploy publishes under is decided by the argv
 * (`--env ?? CLOUDFLARE_ENV`), and a runner handed only a path could not carry that decision.
 * {@link hostDeployArgs} builds it and {@link assertPublishesDeclaredWorker} holds it, so an injected runner
 * receives exactly what the real one spawns.
 */
export type RunHostDeploy = (args: readonly string[], dir: string) => Promise<void>;

/** Everything one gated deploy needs. */
export interface HostDeployOptions {
  /** The capability that owns this Worker. */
  capability: string;
  /** The npm package it ships in — named in the reason when the version is what moved. */
  pkg: string;
  /**
   * The package version being deployed, or `null` when it could not be read.
   *
   * `null` deploys **and writes no stamp**, so the next run reads an unstamped Worker and deploys
   * again. A stamp carrying a version this run invented would match itself forever and skip a real
   * upgrade — silently, which is the half of the problem that has no symptom.
   */
  version: string | null;
  /** The resolved config, before its stamp. */
  config: WorkflowHostTemplate;
  /** The installed package's worker directory — where the temp config is written, so `main` resolves. */
  dir: string;
  /**
   * The generated entry this host is deployed from, when the project composes a peer it can be handed —
   * `hostEntrySource`'s answer. Written beside the temp config as {@link hostEntryFile}, named as the
   * config's `main`, and removed with it. Absent, the host deploys from its own `worker.ts`.
   */
  entry?: string;
  /** The environment. Names the temp config, and nothing else here. */
  env: string;
  /** Read the deployed Worker's vars. Omitted, nothing is known and the Worker deploys. */
  readVars?: ReadWorkerVars;
  /** Record the stamp once the deploy has finished. Omitted, none is recorded and the next run deploys again. */
  writeVar?: WriteWorkerVar;
  /** Ship it. Defaults to {@link hostDeployArgs}, spawned for the account below. */
  runDeploy?: RunHostDeploy;
  /** How the one retry of an unseen Worker waits. Defaults to a real timer; a test states it. */
  retryWait?: RetryWait;
  /**
   * Who wrangler authenticates as. Required by the default runner, unused when one is injected.
   *
   * **A {@link WranglerAccount}, and the union is the point.** `deployKit` passes the project's *selection*,
   * so the `cloudflare.accountId` pin travels with it and a mismatch is refused; a capability provisioner
   * passes the pair its command already resolved. `runWrangler` builds the child through `cloudflare/childEnv`.
   *
   * Never narrow it to a bare pair with `credentials ?? null`: `null` means "this project names no account"
   * and resolves the default `<config>/cloudflare.json`, so a half-filled named credentials file would reach
   * another tenant's token with the pin dropped. The selection keeps "incomplete" and "unclaimed" apart.
   */
  account?: WranglerAccount;
  /** `--force`: ship regardless of the stamp, and read nothing. For a recovery run. */
  force?: boolean;
  /**
   * The environment wrangler will inherit. Defaults to `process.env`, which is what a provisioner runs in.
   *
   * Half of what selects a wrangler stanza — `--env ?? CLOUDFLARE_ENV` — and therefore an input to the
   * name this Worker is published under, which is why {@link assertPublishesDeclaredWorker} reads it
   * rather than reading the argv alone. A test states it; nothing else should.
   */
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * **The argv one kit Worker is deployed with, and the one place its stanza is stated.**
 *
 * A generated host config is one complete file per environment: its `name` already carries the environment
 * (`acme-prod-email`) and it has no `env` section. So the stanza it publishes is always the top level, and
 * {@link TOP_LEVEL_STANZA_ARG} says so. Left unsaid, wrangler resolves `args.env ?? CLOUDFLARE_ENV` and
 * `appendEnvName` runs regardless, so an operator with `CLOUDFLARE_ENV=prod` exported would publish
 * `acme-prod-email-prod`.
 *
 * {@link NO_PROVISION_ARG}, because a deploy is not a provision: media and storage derive their bucket from the
 * project and nothing checks it exists, so with provisioning on wrangler would create it. With it off, a
 * missing bucket fails that Worker's row.
 */
export function hostDeployArgs(configPath: string): string[] {
  return ["deploy", "--config", configPath, TOP_LEVEL_STANZA_ARG, NO_PROVISION_ARG];
}

/**
 * A capability package's stamped version, or `null` when it cannot be read.
 *
 * Resolved from the **project**, never from the CLI's own copy: a globally installed `pithy`
 * asking its own `node_modules` would report its version of `@pithy-sh/email` for a Worker built from
 * the project's, and the stamp would then be a confident lie rather than an absence.
 *
 * `null` rather than a throw. This is one input to a change gate, and a version nobody can read is a
 * reason to deploy, not a reason to fail a deploy that would otherwise have worked.
 */
export async function kitPackageVersion(projectDir: string, pkg: string): Promise<string | null> {
  try {
    const module = await kitImport<{ PACKAGE_VERSION?: unknown }>(projectDir, `${pkg}/src/version.generated`);
    return typeof module.PACKAGE_VERSION === "string" && module.PACKAGE_VERSION !== "" ? module.PACKAGE_VERSION : null;
  } catch {
    return null;
  }
}

/**
 * The default runner: {@link hostDeployArgs}'s argv, in the installed package's worker dir.
 *
 * It spawns the argv it is handed and builds none of its own, so the argv the gate held is the argv that
 * runs. `runWrangler` builds the child's environment from {@link HostDeployOptions.account}, so a pin the
 * credentials contradict refuses rather than deploying to whichever tenant the shell exported.
 */
function defaultRunDeploy(account: WranglerAccount): RunHostDeploy {
  return async (args, dir) => {
    await runWrangler([...args], { account, cwd: dir });
  };
}

/** What {@link planHostDeploy} decided for one kit Worker: whether a deploy would upload it, and why. */
export interface HostDeployPlan {
  /** The capability that owns the Worker — `email`. */
  capability: string;
  /** The script name the deploy would publish, e.g. `acme-prod-email`. */
  worker: string;
  /** Whether wrangler would run. `false` is the stamp matching. */
  deploy: boolean;
  /** The sentence the run would print beside its outcome. */
  reason: string;
}

/** The gate's answer, and everything the upload after it needs. */
interface HostDeployDecision extends HostDeployPlan {
  /** The config wrangler would read: marked {@link UNFINISHED_STAMP} when the version is known. */
  stamped: WorkflowHostTemplate;
  /** The stamp recorded once the deploy has finished, or `undefined` when the version could not be read. */
  stamp: string | undefined;
  /** Where the generated entry is written, when the host is handed one. */
  entryPath: string | undefined;
  /** Where the temporary config is written. */
  configPath: string;
  /** The argv wrangler is spawned with. */
  args: string[];
}

/**
 * The stamp verdict, and every refusal the upload is held to — everything a deploy decides before it writes.
 * Shared by {@link deployHostWorker} and {@link planHostDeploy}, so a plan and a deploy cannot disagree.
 */
async function decideHostDeploy(options: HostDeployOptions): Promise<HostDeployDecision> {
  const worker = options.config.name;
  // The generated entry is `main` before the stamp is taken, so a host that starts or stops being handed a peer
  // is a changed config and redeploys rather than being skipped as current.
  const entryPath = options.entry === undefined ? undefined : join(options.dir, hostEntryFile(options.env));
  const config =
    entryPath === undefined ? options.config : { ...options.config, main: `./${hostEntryFile(options.env)}` };
  const current = options.version === null ? undefined : deployStamp(config, options.version);
  const stamped = current === undefined ? config : stampConfig(config, UNFINISHED_STAMP);

  const verdict =
    current === undefined
      ? { deploy: true, reason: `${options.pkg}'s version could not be read, so it was deployed unstamped.` }
      : stampVerdict({
          worker,
          pkg: options.pkg,
          current,
          // Skipped entirely under `--force`: there is nothing a read could say that would change the
          // answer, and a recovery run should not also depend on the account answering.
          deployed: options.force ? { state: "absent" } : await readDeployedStamp(options.readVars, worker),
          force: options.force,
        });

  const configPath = join(options.dir, hostConfigFile(options.env));
  const args = hostDeployArgs(configPath);
  if (verdict.deploy) {
    // The last moment this is still recoverable: after the upload the only remedy is deleting a live Worker.
    // Asked of the argv about to be spawned rather than of the code that built it.
    assertPublishesDeclaredWorker({
      configPath,
      config: stamped,
      args,
      processEnv: options.processEnv ?? process.env,
    });
    // And the same argv creates nothing. Every provisioner reaches this, and a provisioner's resources are
    // created by its own API calls before it gets here — never by the upload.
    assertCreatesNoResources(args);
  }
  return {
    capability: options.capability,
    worker,
    deploy: verdict.deploy,
    reason: verdict.reason,
    stamped,
    stamp: current,
    entryPath,
    configPath,
    args,
  };
}

/**
 * **What {@link deployHostWorker} would do, without doing it** — `pithy deploy --dry-run`'s kit half.
 * The stamp is read and every refusal is made exactly as the deploy makes them; then it stops, before the
 * temporary config is written, before wrangler, and before the upload is announced.
 */
export async function planHostDeploy(options: HostDeployOptions): Promise<HostDeployPlan> {
  const { capability, worker, deploy, reason } = await decideHostDeploy(options);
  return { capability, worker, deploy, reason };
}

/**
 * Deploy one kit Worker, unless its deployed stamp says nothing has changed.
 *
 * The temp config carries {@link UNFINISHED_STAMP}, and the stamp is recorded only after wrangler has returned:
 * wrangler sets the Worker's triggers after its upload, so a deploy that fails there has its code live, and the
 * marker is what keeps the next run from reading it as current. The temp config is removed whether the deploy
 * worked or not: it holds provisioned resource ids and it lives inside an installed package. A first deploy
 * Cloudflare has not propagated yet is run once more, against the same temp config, before it is removed.
 */
export async function deployHostWorker(options: HostDeployOptions): Promise<HostDeployOutcome> {
  const decision = await decideHostDeploy(options);
  const { worker, stamped, stamp, entryPath, configPath, args } = decision;
  if (!decision.deploy) {
    return { capability: options.capability, worker, outcome: "unchanged", reason: decision.reason };
  }

  const run = options.runDeploy ?? defaultRunDeploy(options.account ?? null);
  // The one place a kit Worker's upload is announced, so every command that ships one inherits it. After
  // the verdict, because a Worker that is already current is not work in flight.
  startStep(worker);
  await writeFile(configPath, `${JSON.stringify(stamped, null, 2)}\n`);
  try {
    if (entryPath !== undefined) await writeFile(entryPath, options.entry as string);
    await withUnseenWorkerRetry(worker, () => run(args, options.dir), options.retryWait);
  } finally {
    await unlink(configPath).catch(() => {});
    if (entryPath !== undefined) await unlink(entryPath).catch(() => {});
  }
  const note = stamp === undefined ? undefined : await recordDeployStamp(options.writeVar, worker, stamp);
  const reason = note === undefined ? decision.reason : `${decision.reason} ${note}`;
  return { capability: options.capability, worker, outcome: "deployed", reason };
}
