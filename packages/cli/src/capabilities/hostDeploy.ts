// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { messageOf, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import {
  assertCreatesNoResources,
  assertPublishesDeclaredWorker,
  NO_PROVISION_ARG,
  TOP_LEVEL_STANZA_ARG,
} from "../project/effectiveConfig";
import { kitImport } from "../project/kitResolve";
import { runWrangler, type WranglerAccount } from "../project/wrangler";
import { DEPLOY_STAMP_VAR, type DeployedStamp, stampConfig, stampVerdict } from "../provision/deployStamp";
import { startStep } from "../terminal/progress";

/**
 * **The one path a kit Worker is deployed through, and therefore the one place the gate lives.**
 *
 * Eight provisioners — email, media, payments, secrets, storage, support, testers and vector — had
 * each grown the same ten lines: write `.wrangler.<env>.json` beside the worker entry so wrangler's
 * relative `main` resolves, shell `wrangler deploy --config`, unlink in a `finally`. None of them
 * compared anything against what was live, so idempotent here meant *safe to re-run*, never *skips
 * when unchanged* (#537).
 *
 * Putting the comparison here rather than in `pithy deploy` is what makes it apply everywhere with no
 * flag: `pithy email provision`, `pithy media provision` and the rest inherit it by calling this, and
 * on a first provision there is no stamp so it deploys. There is no `--if-changed` and there will not
 * be one — a flag that can only ever be true is one somebody eventually leaves off believing it does
 * something, which is the exact bug this closes.
 *
 * **A provisioner takes no `force`, and that is deliberate.** `pithy <capability> provision` creates
 * account resources; a run whose only purpose is to re-upload an unchanged Worker should not also be
 * a run that touches buckets, namespaces and Email Routing rules. The re-upload is
 * `pithy deploy --env <env> --kit --force`, which creates nothing and is what `docs/commands/*.md`
 * name — and since #537 it resolves from the adopter's own composed capability, so it ships the same
 * config the provisioner would.
 *
 * **The adopter's own Workers never come through here.** `project/deploy.ts` ships `apps/*` and is
 * ungated on purpose: their code is the thing that changed, and the CLI cannot see a bundle.
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
 * **It takes the argv, not the config path (#584).** The stanza a deploy publishes under is decided by
 * the argv — `--env ?? CLOUDFLARE_ENV`, so an argv that names none hands the decision to the operator's
 * shell — and a runner handed only a path could not carry that decision, which is how the one call site
 * that built its own argv built it without a stanza and without anything able to observe the omission.
 * {@link hostDeployArgs} is where it is built and {@link assertPublishesDeclaredWorker} is what holds it;
 * an injected runner receives exactly what the real one spawns.
 */
export type RunHostDeploy = (args: readonly string[], dir: string) => Promise<void>;

/** Read a deployed Worker's plain-text vars. `null` means the account holds no Worker of that name. */
export type ReadWorkerVars = (scriptName: string) => Promise<Record<string, string> | null>;

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
  /** The resolved config, before its stamp. Exactly what would have been written before #537. */
  config: WorkflowHostTemplate;
  /** The installed package's worker directory — where the temp config is written, so `main` resolves. */
  dir: string;
  /** The environment. Names the temp config, and nothing else here. */
  env: string;
  /** Read the deployed Worker's vars. Omitted, nothing is known and the Worker deploys. */
  readVars?: ReadWorkerVars;
  /** Ship it. Defaults to {@link hostDeployArgs}, spawned for the account below. */
  runDeploy?: RunHostDeploy;
  /**
   * Who wrangler authenticates as. Required by the default runner, unused when one is injected.
   *
   * **A {@link WranglerAccount}, and the union is the whole point.** `deployKit` holds the project's
   * *selection* and passes that, so the `cloudflare.accountId` pin travels with it and #206's mismatch
   * refusal still runs; the eight capability provisioners hold a pair their command already resolved and
   * pass that. The four lines that used to spread a pair onto `runWrangler`'s `env` are gone — that was
   * the second of three copies, and the reason the third (`pithy dev`) could be missing with nothing
   * noticing (#555). `runWrangler` builds the child through `cloudflare/childEnv` now.
   *
   * **Narrowing this to a bare pair was a bug, briefly.** With `credentials ?? null`, a project whose
   * named credentials file held only half the pair fell through to `null` — which does not mean "no
   * credentials", it means "this project names no account", and so resolved the *default*
   * `<config>/cloudflare.json`. On a two-account machine that is another tenant's live token, with the
   * pin that would have refused it dropped one frame earlier. Passing the selection is what keeps
   * "incomplete" and "unclaimed" from becoming the same value.
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
 * A generated host config is one complete file per environment: its `name` already carries the
 * environment (`acme-prod-email`) and it has no `env` section at all. So the stanza it publishes is
 * always the top level — and {@link TOP_LEVEL_STANZA_ARG} is how an argv says that out loud.
 *
 * Saying it is not decoration (#584). wrangler resolves `args.env ?? CLOUDFLARE_ENV`, its missing-stanza
 * branch only *warns* when the config has no `env` section, and `appendEnvName` runs regardless — so the
 * argv that omitted this published `acme-prod-email-prod` for every operator with `CLOUDFLARE_ENV=prod`
 * exported, and `acme-prod-email` for everyone else. A Worker under a name nothing references.
 *
 * **And {@link NO_PROVISION_ARG}, because a deploy is not a provision (#589).** Media and storage derive
 * their bucket from the project and nothing checks it exists, so without the switch wrangler created the
 * bucket on a `pithy deploy --kit` into an environment nobody had provisioned. With it, a missing bucket
 * fails that Worker's row instead.
 */
export function hostDeployArgs(configPath: string): string[] {
  return ["deploy", "--config", configPath, TOP_LEVEL_STANZA_ARG, NO_PROVISION_ARG];
}

/**
 * A capability package's stamped version, or `null` when it cannot be read.
 *
 * Resolved from the **project**, never from the CLI's own copy (#533): a globally installed `pithy`
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
 * What the deployed Worker says about itself, in the four states {@link stampVerdict} branches on.
 *
 * Every failure becomes a state rather than a throw. The account may be unreachable, the token may
 * lack Workers Read, the API may 500 — none of those is a reason to stop a deploy, and all of them
 * are reasons to run one.
 */
async function readDeployedStamp(read: ReadWorkerVars | undefined, scriptName: string): Promise<DeployedStamp> {
  if (!read) return { state: "unreadable", detail: "No Cloudflare client was available to read it." };
  try {
    const vars = await read(scriptName);
    if (vars === null) return { state: "absent" };
    const stamp = vars[DEPLOY_STAMP_VAR];
    return stamp ? { state: "read", stamp } : { state: "unstamped" };
  } catch (error) {
    return { state: "unreadable", detail: error instanceof PithyError ? error.payload.message : messageOf(error) };
  }
}

/**
 * The default runner: {@link hostDeployArgs}'s argv, in the installed package's worker dir.
 *
 * It spawns the argv it is handed and builds none of its own, so the stanza a reviewer can see in
 * `hostDeployArgs` is the stanza wrangler is told, and the argv the gate held is the argv that runs.
 *
 * The environment comes from `cloudflareChildEnv`, inside `runWrangler` — so a host Worker ships to the
 * account the project claims, and a pin the credentials contradict refuses rather than deploying to
 * whichever tenant the shell last exported a token for (#555). See {@link HostDeployOptions.account} for
 * why what arrives here is the selection or the pair, and never the pair flattened to `null`.
 */
function defaultRunDeploy(account: WranglerAccount): RunHostDeploy {
  return async (args, dir) => {
    // `runWrangler` refuses an argv that leaves provisioning on, whatever name it is called by (#589).
    await runWrangler([...args], { account, cwd: dir });
  };
}

/**
 * Deploy one kit Worker, unless its deployed stamp says nothing has changed.
 *
 * The temp config carries the stamp, so the bundle and the claim about it are written by one atomic
 * operation — there is no second API write, and no way for a stamp to describe a deploy that failed.
 * It is removed whether the deploy worked or not: it holds provisioned resource ids and it lives
 * inside an installed package.
 */
export async function deployHostWorker(options: HostDeployOptions): Promise<HostDeployOutcome> {
  const worker = options.config.name;
  const stamped = options.version === null ? options.config : stampConfig(options.config, options.version);
  const current = stamped.vars?.[DEPLOY_STAMP_VAR];

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

  if (!verdict.deploy) {
    return { capability: options.capability, worker, outcome: "unchanged", reason: verdict.reason };
  }

  const run = options.runDeploy ?? defaultRunDeploy(options.account ?? null);
  const configPath = join(options.dir, `.wrangler.${options.env}.json`);
  const args = hostDeployArgs(configPath);
  // **The last moment this is still recoverable, and it is ahead of the narration and the write.** After
  // the upload the only remedy is deleting a live Worker; before it, a refusal is a sentence. Asked of
  // the argv about to be spawned rather than of the code that built it, so a call site that starts
  // building its own is covered on the day it does (#584).
  assertPublishesDeclaredWorker({
    configPath,
    config: stamped,
    args,
    processEnv: options.processEnv ?? process.env,
  });
  // And the same argv creates nothing. Every provisioner reaches this, and a provisioner's resources are
  // created by its own API calls before it gets here — never by the upload.
  assertCreatesNoResources(args);
  // **The one place a kit Worker's upload is announced, so every command that ships one inherits it
  // (#578).** `pithy deploy --kit` reaches here, and so does every `pithy <capability> provision` —
  // through two packages that carry no progress parameter and should not grow one. Raised after the
  // stamp verdict, because a Worker that is already current is not work in flight, and a `▸` line for
  // an upload that never happens is the kind of narration nobody trusts twice.
  startStep(worker);
  await writeFile(configPath, `${JSON.stringify(stamped, null, 2)}\n`);
  try {
    await run(args, options.dir);
  } finally {
    await unlink(configPath).catch(() => {});
  }
  return { capability: options.capability, worker, outcome: "deployed", reason: verdict.reason };
}
