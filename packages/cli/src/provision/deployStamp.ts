// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";

/**
 * **What a kit Worker says about itself, so a deploy can tell whether it needs to happen.**
 *
 * A capability that owns Workflows ships a Worker of its own, and until #537 nothing decided whether
 * it needed redeploying. `deployWorker` resolved the template and shelled `wrangler deploy`, every
 * time. That left an adopter's CI two options and both were bad: re-upload an unchanged Worker on
 * every push to main, versioning the script that hosts their durable jobs and paying a full
 * provisioning pass — or leave it out, and let the Worker go **stale silently**. It has no request
 * and no access to `pithy.config.ts`, so its configuration is stamped into its vars at provision
 * time: `EMAIL_THEME`, `BASE_URL`, one `EMAIL_MESSAGES_<locale>` per locale, resolved binding ids,
 * the cron. Edit a theme and the kit's Worker keeps sending the old one. Nothing fails.
 *
 * So the deployed Worker carries one var naming what it was deployed from. It ships **inside the
 * config wrangler deploys**, which is what makes it trustworthy: the bundle and its stamp are written
 * by one atomic operation, so the stamp can never claim a deploy that did not happen. There is no
 * second API write and nothing to clean up.
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
function canonicalize(value: unknown): unknown {
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
 * The config as it will be deployed: the caller's, plus its stamp.
 *
 * A copy rather than a mutation, because the caller's config is what a test compares against and what
 * a resolver may hand to something else on the same run.
 */
export function stampConfig(config: WorkflowHostTemplate, version: string): WorkflowHostTemplate {
  return { ...config, vars: { ...config.vars, [DEPLOY_STAMP_VAR]: deployStamp(config, version) } };
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
 * What reading the deployed stamp established. Four states, and three of them are ways of not knowing.
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
  /** The read itself failed — no credentials, an unreachable account, a 500. */
  | { readonly state: "unreadable"; readonly detail: string };

/** Everything the gate compares, named so the reason it prints can name it too. */
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
  const { worker, pkg, current, deployed } = comparison;
  if (comparison.force) return { deploy: true, reason: "--force was given." };
  if (deployed.state === "absent") return { deploy: true, reason: `${worker} is not deployed.` };
  if (deployed.state === "unstamped") return { deploy: true, reason: `${worker} carries no deploy stamp.` };
  if (deployed.state === "unreadable") {
    return { deploy: true, reason: `${worker}'s deploy stamp could not be read. ${deployed.detail}` };
  }

  const live = parseDeployStamp(deployed.stamp);
  const mine = parseDeployStamp(current);
  // `mine` is built two lines from here by this same module, so an unreadable one is not an adopter's
  // problem — but it is still doubt, and doubt deploys rather than throws inside a deploy.
  if (!live || !mine) return { deploy: true, reason: `${worker}'s deploy stamp is not one this release can read.` };

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
