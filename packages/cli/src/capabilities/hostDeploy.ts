// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { messageOf, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { kitImport } from "../project/kitResolve";
import { runWrangler } from "../project/wrangler";
import { DEPLOY_STAMP_VAR, type DeployedStamp, stampConfig, stampVerdict } from "../provision/deployStamp";

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

/** Ship one resolved config. The seam tests replace so nothing here spawns wrangler. */
export type RunHostDeploy = (configPath: string, dir: string) => Promise<void>;

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
  /** Ship it. Defaults to `wrangler deploy --config <path>` with the credentials below. */
  runDeploy?: RunHostDeploy;
  /** The pair handed to wrangler. Required by the default runner, unused when one is injected. */
  credentials?: { accountId: string; apiToken: string };
  /** `--force`: ship regardless of the stamp, and read nothing. For a recovery run. */
  force?: boolean;
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

/** The default runner: `wrangler deploy --config <resolved>`, in the installed package's worker dir. */
function defaultRunDeploy(credentials: { accountId: string; apiToken: string } | undefined): RunHostDeploy {
  return async (configPath, dir) => {
    await runWrangler(["deploy", "--config", configPath], {
      cwd: dir,
      ...(credentials
        ? { env: { CLOUDFLARE_API_TOKEN: credentials.apiToken, CLOUDFLARE_ACCOUNT_ID: credentials.accountId } }
        : {}),
    });
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

  const run = options.runDeploy ?? defaultRunDeploy(options.credentials);
  const configPath = join(options.dir, `.wrangler.${options.env}.json`);
  await writeFile(configPath, `${JSON.stringify(stamped, null, 2)}\n`);
  try {
    await run(configPath, options.dir);
  } finally {
    await unlink(configPath).catch(() => {});
  }
  return { capability: options.capability, worker, outcome: "deployed", reason: verdict.reason };
}
