// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { messageOf, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { setStanzaVar } from "../project/stanzaVars";

/**
 * **What a kit Worker says about itself, so a deploy can tell whether it needs to happen.**
 *
 * A capability that owns Workflows ships a Worker of its own, and something has to decide whether it
 * needs redeploying. Deploying it every time leaves an adopter's CI two options and both are bad:
 * re-upload an unchanged Worker on every push to main, versioning the script that hosts their durable
 * jobs and paying a full provisioning pass — or leave it out, and let the Worker go **stale silently**.
 * It has no request and no access to `pithy.config.ts`, so its configuration is stamped into its vars
 * at provision time: `EMAIL_THEME`, `BASE_URL`, one `EMAIL_MESSAGES_<locale>` per locale, resolved binding ids,
 * the cron. Edit a theme and the kit's Worker keeps sending the old one. Nothing fails.
 *
 * So the deployed Worker carries one var naming what it was deployed from, and it is written **only once
 * the whole deploy has finished**. wrangler sets a Worker's triggers after its upload — the `workers.dev`
 * subdomain, routes, custom domains, crons — and an app Worker is then probed at its declared address, so
 * a deploy can fail with its code already live. The upload therefore carries {@link UNFINISHED_STAMP},
 * which matches nothing, and the real stamp replaces it through {@link recordDeployStamp} after every step
 * has passed. A deploy that fails anywhere leaves `unfinished`, and the next run deploys again.
 *
 * ## Two inputs, because they answer two questions
 *
 * The **package version** stands in for the bundle, which is not cheap to hash and which the CLI
 * cannot see anyway — the entry is inside `node_modules` and wrangler does the bundling. The **hash**
 * covers everything the provisioner stamps: vars, binding ids, cron, compatibility date, worker name.
 * A kit upgrade moves the version; a theme edit moves only the hash. Either alone misses half the
 * cases, and the config half is the silent one.
 *
 * ## When in doubt, deploy
 *
 * No stamp, an unreadable stamp, no Worker, an unreachable account — {@link stampVerdict} answers
 * *deploy* to all of them, with the reason it did. A false redeploy costs seconds; a false skip is
 * silent. The gate can never stop a deploy for a reason nobody can see, so its worst case is exactly
 * today's behavior. **Undeclared and unchanged are not the same fact.**
 */

/**
 * The var every kit Worker carries. Read back off the deployed script's plain-text bindings.
 *
 * `PITHY_` because it lands in an adopter's Cloudflare dashboard beside their own vars, and a name
 * that does not say whose it is reads as something they set and forgot.
 */
export const DEPLOY_STAMP_VAR = "PITHY_DEPLOY_STAMP";

/**
 * The value an upload carries in {@link DEPLOY_STAMP_VAR} until its deploy finishes. It parses as no stamp
 * either kind of Worker writes, so a Worker left holding it is never skipped.
 */
export const UNFINISHED_STAMP = "unfinished";

/** How many hex characters of the digest the stamp carries. Change detection, not a signature. */
const HASH_LENGTH = 16;

/**
 * The stamp's two halves, split on the one character semver cannot contain.
 *
 * A version may hold `.`, `-` and `+` (`0.2.0-rc.1+build.5`), so none of those separates anything.
 * `/` does, and it reads as a path rather than as punctuation inside either half.
 */
const SEPARATOR = "/";

/**
 * A value with its object keys recursively sorted, so `JSON.stringify` is stable.
 *
 * The input is a committed JSONC template that a human edits. Moving `vars` above `d1_databases`
 * changes nothing about what is deployed, and a hash that moved on it would redeploy every kit Worker
 * on a comment-only edit — which is the over-deploying half of the problem this closes, reintroduced
 * by the fix for the other half.
 *
 * Arrays keep their order: `workflows` and `triggers.crons` are ordered by the resolver and a
 * reordering there is a real change. `comment-json`'s parse hangs its comments off symbol keys, which
 * `Object.keys` does not see, so a template's comments are outside the hash by construction.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
  return sorted;
}

/**
 * The hash of one resolved config, **with the stamp var excluded from its own input**.
 *
 * Excluded because it cannot be otherwise: the var holds the hash, so hashing it would mean solving
 * for a fixed point. Left in, the first deploy writes hash A, the second hashes a config containing
 * hash A and gets hash B, and the two never converge — every run redeploys and the gate is decoration.
 */
export function configHash(config: WorkflowHostTemplate): string {
  const { [DEPLOY_STAMP_VAR]: _stamp, ...vars } = config.vars ?? {};
  const withoutStamp: WorkflowHostTemplate = { ...config, vars };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(withoutStamp)))
    .digest("hex")
    .slice(0, HASH_LENGTH);
}

/** The stamp a deploy of this config, from this package version, would write. */
export function deployStamp(config: WorkflowHostTemplate, version: string): string {
  return `${version}${SEPARATOR}${configHash(config)}`;
}

/**
 * The config as it will be uploaded: the caller's, with `stamp` in {@link DEPLOY_STAMP_VAR}.
 *
 * A copy rather than a mutation, because the caller's config is what a test compares against and what
 * a resolver may hand to something else on the same run.
 */
export function stampConfig(config: WorkflowHostTemplate, stamp: string): WorkflowHostTemplate {
  // The vars are copied one by one into a block of the copy's own, so the stamp never lands in the caller's.
  const { vars = {}, ...rest } = config;
  const stamped: WorkflowHostTemplate = rest;
  for (const [name, value] of Object.entries(vars)) setStanzaVar(stamped, name, value);
  setStanzaVar(stamped, DEPLOY_STAMP_VAR, stamp);
  return stamped;
}

/** A stamp read off a deployed Worker, split back into the two facts it carries. */
export interface ParsedStamp {
  /** The package version that Worker was deployed from. */
  version: string;
  /** The hash of the config it was deployed with. */
  hash: string;
}

/**
 * Split a stamp read off a deployed Worker, or `null` when it is not one this release can read.
 *
 * `null` rather than a throw, and a deploy rather than a skip: a stamp written by a future release in
 * a shape this one does not know is exactly the doubt the rule is about.
 */
export function parseDeployStamp(raw: string | undefined | null): ParsedStamp | null {
  if (!raw) return null;
  const at = raw.indexOf(SEPARATOR);
  if (at <= 0) return null;
  const version = raw.slice(0, at);
  const hash = raw.slice(at + SEPARATOR.length);
  if (hash === "" || hash.includes(SEPARATOR)) return null;
  return { version, hash };
}

/**
 * What reading the deployed stamp established. Five states, and four of them are ways of not knowing.
 *
 * Separated rather than collapsed into `string | null` because the *reason* is what the row prints,
 * and "there is no such Worker" and "the account would not answer" send an operator to different
 * places. Both deploy.
 */
export type DeployedStamp =
  /** The Worker is there and carries a stamp. The only state that can produce a skip. */
  | { readonly state: "read"; readonly stamp: string }
  /** No Worker of that name on the account — a first deploy, or one somebody deleted. */
  | { readonly state: "absent" }
  /** The Worker is there and carries no stamp: deployed by a release older than this gate. */
  | { readonly state: "unstamped" }
  /** The Worker carries {@link UNFINISHED_STAMP}: its last deploy failed after the upload, or was never stamped. */
  | { readonly state: "unfinished" }
  /** The read itself failed — no credentials, an unreachable account, a 500. */
  | { readonly state: "unreadable"; readonly detail: string };

/** Everything the gate compares. The Worker is named by the row the reason is printed on, not by the reason. */
export interface StampComparison {
  /** The deployed script name, e.g. `acme-prod-email`. What an operator finds in the dashboard. */
  worker: string;
  /** The npm package the Worker ships in, e.g. `@pithy-sh/email`. Named when the version moved. */
  pkg: string;
  /** The stamp this deploy would write — {@link deployStamp} over the resolved config. */
  current: string;
  /** What reading the deployed Worker established. */
  deployed: DeployedStamp;
  /** `--force`: ship regardless, for a recovery run. */
  force?: boolean;
}

/** The gate's answer: whether to deploy, and the sentence that says why. */
export interface StampVerdict {
  /** Whether to run `wrangler deploy`. */
  deploy: boolean;
  /** One sentence, printed on the row and carried in the `--json` payload. Never empty. */
  reason: string;
}

/**
 * Whether this Worker needs deploying, and why.
 *
 * Every branch but one answers *deploy*. The single skip requires a Worker that is there, carrying a
 * stamp this release can read, whose version **and** hash both match what this run would write.
 */
export function stampVerdict(comparison: StampComparison): StampVerdict {
  const { pkg, current, deployed } = comparison;
  const doubt = doubtVerdict(deployed, comparison.force);
  if (doubt) return doubt;

  const live = parseDeployStamp(deployed.state === "read" ? deployed.stamp : null);
  const mine = parseDeployStamp(current);
  // `mine` is built two lines from here by this same module, so an unreadable one is not an adopter's
  // problem — but it is still doubt, and doubt deploys rather than throws inside a deploy.
  if (!live || !mine) return { deploy: true, reason: "Its deploy stamp was not one this release can read." };

  const moved = live.version !== mine.version;
  const changed = live.hash !== mine.hash;
  if (moved && changed) {
    return {
      deploy: true,
      reason: `${pkg} moved from ${live.version} to ${mine.version}, and its resolved configuration changed.`,
    };
  }
  if (moved) return { deploy: true, reason: `${pkg} moved from ${live.version} to ${mine.version}.` };
  if (changed) return { deploy: true, reason: "Its resolved configuration changed." };
  return { deploy: false, reason: `${pkg} ${mine.version} is deployed with this configuration.` };
}

/**
 * The verdict every state but a readable stamp reaches, or `undefined` when the stamp is there to compare.
 * Shared by {@link stampVerdict} and {@link bundleStampVerdict}, so a kit Worker and an app Worker give the
 * same sentence for the same doubt.
 */
function doubtVerdict(deployed: DeployedStamp, force: boolean | undefined): StampVerdict | undefined {
  if (force) return { deploy: true, reason: "--force was given." };
  // **Past tense, because the reason is read after the outcome.** The row prints `<worker>: deployed.
  // <reason>`, so a reason in the present tense describes an account the deploy has just changed:
  // `acme-prod-email: deployed. acme-prod-email is not deployed.` is two statements, and the second is
  // false by the time anybody reads it. Each sentence here is about what the account held before this run,
  // which stays true whatever the run then did — and names nothing the row has not already named.
  if (deployed.state === "absent") return { deploy: true, reason: "It was not on the account." };
  if (deployed.state === "unstamped") return { deploy: true, reason: "It carried no deploy stamp." };
  if (deployed.state === "unfinished")
    return { deploy: true, reason: "Its last deploy did not record that it finished." };
  if (deployed.state === "unreadable") {
    return { deploy: true, reason: `Its deploy stamp could not be read. ${deployed.detail}` };
  }
  return undefined;
}

/** What an app Worker's gate compares: the stamp this deploy would write, and what the account holds. */
export interface BundleStampComparison {
  /** The hash of the bundle wrangler would upload, with its resolved configuration. */
  current: string;
  /** What reading the deployed Worker established. */
  deployed: DeployedStamp;
  /** `--force`: ship regardless. */
  force?: boolean;
}

/**
 * Whether an app Worker needs deploying, and why. Its stamp is the bundle hash alone: the adopter's code has
 * no package version, so the one skip is a live stamp equal to the hash this deploy would write.
 */
export function bundleStampVerdict(comparison: BundleStampComparison): StampVerdict {
  const { current, deployed } = comparison;
  const doubt = doubtVerdict(deployed, comparison.force);
  if (doubt) return doubt;
  if (deployed.state === "read" && deployed.stamp === current) {
    return { deploy: false, reason: "This bundle and configuration are already deployed." };
  }
  return { deploy: true, reason: "Its bundle or resolved configuration changed." };
}

/** Read a deployed Worker's plain-text vars. `null` means the account holds no Worker of that name. */
export type ReadWorkerVars = (scriptName: string) => Promise<Record<string, string> | null>;

/**
 * What the deployed Worker says about itself, in the five states the verdicts branch on.
 *
 * Every failure becomes a state rather than a throw. The account may be unreachable, the token may lack
 * Workers Read, the API may 500: none of those is a reason to stop a deploy, and all of them are reasons to
 * run one.
 */
export async function readDeployedStamp(read: ReadWorkerVars | undefined, scriptName: string): Promise<DeployedStamp> {
  if (!read) return { state: "unreadable", detail: "No Cloudflare client was available to read it." };
  try {
    const vars = await read(scriptName);
    if (vars === null) return { state: "absent" };
    const stamp = vars[DEPLOY_STAMP_VAR];
    if (stamp === UNFINISHED_STAMP) return { state: "unfinished" };
    return stamp ? { state: "read", stamp } : { state: "unstamped" };
  } catch (error) {
    return { state: "unreadable", detail: error instanceof PithyError ? error.payload.message : messageOf(error) };
  }
}

/** Set one plain-text var on a deployed Worker, leaving every other binding as it is. */
export type WriteWorkerVar = (scriptName: string, name: string, value: string) => Promise<void>;

/**
 * Record that a deploy finished, by writing its stamp over the {@link UNFINISHED_STAMP} its upload carried.
 * Called only after every step of the deploy has passed.
 *
 * It never throws: the deploy it records has already succeeded. It answers the sentence a row carries when
 * the write failed, or `undefined`. An unwritten stamp leaves `unfinished`, so the next run uploads again rather
 * than skipping. No writer answers `undefined` too: the writer and the reader come from the same account, so the
 * row's reason has already said that no Cloudflare client was available.
 */
export async function recordDeployStamp(
  write: WriteWorkerVar | undefined,
  scriptName: string,
  stamp: string,
): Promise<string | undefined> {
  if (!write) return undefined;
  try {
    await write(scriptName, DEPLOY_STAMP_VAR, stamp);
    return undefined;
  } catch (error) {
    const detail = error instanceof PithyError ? error.payload.message : messageOf(error);
    return `Its deploy stamp could not be recorded, so the next deploy uploads it again. ${detail}`;
  }
}
