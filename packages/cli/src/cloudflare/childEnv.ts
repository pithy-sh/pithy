// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CLOUDFLARE_CREDENTIAL_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import type { StatePathOptions } from "../notifier/state";
import { type CloudflareAccountSelection, type CloudflareCredentials, cloudflareEnv } from "./config";

/**
 * The environment of a child process that may authenticate to Cloudflare — the **only** way one is built.
 *
 * **A child inherits the shell, and the shell is not the project.** `wrangler` reads
 * `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` out of its own process environment, so a spawn that
 * hands over `process.env` untouched authenticates as whatever the operator's shell last exported. On a
 * machine with one account that is invisible; on a machine with two it is the whole of #555 — `pithy dev`
 * copied the parent environment wholesale, and a magic link went out through a tenant that does not own
 * `pithy.sh`, five times, and failed five times. Resolving against the wrong account does not fail loudly.
 * It reaches another company's tenant and exits 0, which is the sentence `project/deploy.ts` has carried
 * since #206 and the reason that command was already correct.
 *
 * **The rule this replaces was written at the call sites, three times, and held at two of them.**
 * `deploy` and `hostDeploy` each carried their own copy of "read the pair, set the two keys"; `dev`
 * carried none. That is this repository's usual arithmetic for a rule that lives at call sites rather
 * than at the thing being called — the same arithmetic {@link CloudflareConfigOptions} records for the
 * account argument itself. So the rule moved here, and `ci/cloudflareChildEnv.test.ts` fails any module
 * that spawns wrangler and builds its environment some other way. A fourth copy cannot land.
 *
 * **It returns the child's whole environment, never an overlay.** #555 was a forgotten merge, and a
 * function handing back a fragment is a function whose merge can be forgotten again. A caller passes the
 * result straight to `spawn`.
 *
 * **It overwrites the credential pair rather than filling gaps, and that can only ever correct.**
 * `resolveCloudflare` already falls back to `process.env` per key, so on a machine with no credentials
 * file the resolved pair *is* the shell's pair and the child is byte-identical to what it was. Where the
 * two differ, the project's file is the one the repository chose. The single exception is `PITHY_OFFLINE`,
 * where the resolution refuses the ambient pair and the child is stripped of it — which is the point of
 * the switch (#218), not an edge of it: a child still carrying the shell's token would authenticate as the
 * very account the operator said to keep out of the run.
 *
 * **Only the pair.** `CLOUDFLARE_CREDENTIAL_KEYS` is the group that means something *together* and the
 * only group that can quietly succeed somewhere unintended; a `SECRETS_STORE_ID` from the wrong account
 * 404s on its first call. The `.dev.vars` a Worker reads is wrangler's business and is untouched here.
 *
 * **Synchronous, matching {@link cloudflareEnv}'s load-bearing sync contract.** Only `account` is awaited,
 * once, by the command layer that already loads the project.
 *
 * It resolves through {@link cloudflareEnv} rather than `resolveCloudflare`, so a pinned `cloudflare.accountId`
 * the credentials contradict refuses **before the spawn** instead of after a send. That refusal is #206's,
 * and inheriting it here is what finally extends it to `pithy dev`, which never resolved an account and so
 * had nothing to compare.
 */
export interface CloudflareChildEnvOptions extends Omit<StatePathOptions, "env"> {
  /** The project's account, from `projectCloudflareAccount`, or `null` when it names none. */
  account: CloudflareAccountSelection | null;
  /**
   * The environment the child would otherwise inherit. Defaults to `process.env`.
   *
   * **One environment, read twice.** It is both what the child gets and what the file→environment
   * overlay reads, because those must not be two different maps: a credential the overlay took from
   * one and a child that ran with the other is the divergence this module exists to close. It is also
   * where `PITHY_CONFIG_DIR` and `PITHY_OFFLINE` are read from, for the same reason.
   */
  base?: NodeJS.ProcessEnv;
  /** Refuse ambient credentials for this resolution, whatever the environment says — see `PITHY_OFFLINE`. */
  offline?: boolean;
}

/**
 * Build the environment for a child that may talk to Cloudflare: everything it would have inherited,
 * with the credential pair replaced by what *this project* resolved. See {@link CloudflareChildEnvOptions}.
 */
export function cloudflareChildEnv(options: CloudflareChildEnvOptions): Record<string, string> {
  const base = options.base ?? process.env;
  const resolved = cloudflareEnv({
    account: options.account,
    env: base,
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.homedir === undefined ? {} : { homedir: options.homedir }),
  });
  return childEnvWith(base, resolved);
}

/**
 * The same environment, for a caller that already **holds** the pair its selection resolved to.
 *
 * **Two inputs, because callers genuinely hold two different things, and neither may hand-roll the
 * spread.** A command resolves the project's selection and passes that ({@link cloudflareChildEnv}); the
 * eight capability provisioners were handed `{ accountId, apiToken }` by the command that built them, one
 * `cloudflareEnv` call earlier, and cannot re-derive the selection behind it — `ConfirmedAccount` carries
 * the id and what vouches for it, never which credentials file supplied it. Asking them to re-resolve
 * from an id alone would read the *default* `cloudflare.json` on a machine whose project names
 * `cloudflare.<name>.json`, and resolve nothing at all.
 *
 * So the pair is a first-class input rather than an exception to the rule. The alternative was an
 * exception list with one entry reading "this one already resolved correctly upstream" — which is the
 * shape #555 arrived in: a rule kept at call sites, true at two of them.
 */
export function credentialedChildEnv(
  credentials: CloudflareCredentials,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return childEnvWith(base, {
    CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
    CLOUDFLARE_API_TOKEN: credentials.apiToken,
  });
}

/**
 * `base`, with every {@link CLOUDFLARE_CREDENTIAL_KEYS} entry taken from `resolved` — set where it has a
 * value, **removed** where it does not.
 *
 * Removed rather than left standing, because "nothing resolved" is `PITHY_OFFLINE`, and the value the
 * shell exported is precisely what that switch refused (#218). Leaving it would make the child the one
 * place in the CLI the off switch does not reach.
 */
function childEnvWith(base: NodeJS.ProcessEnv, resolved: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of CLOUDFLARE_CREDENTIAL_KEYS) {
    const value = resolved[key];
    if (value) env[key] = value;
    else delete env[key];
  }
  return env;
}

/**
 * Which credential keys the project's resolution **replaced** on the way into a child — for the one line
 * that says so at startup.
 *
 * **The fact a developer cannot otherwise get at.** `wrangler whoami` reports the shell's account and
 * `pithy doctor` reports the project's, and when they disagree nothing in either output says the second
 * is the one every Pithy-spawned Worker will use. That is not a fault and must not refuse — a shell that
 * exports a token for other work is ordinary — but discovering it by reading two commands and inferring
 * the third is how #555 cost an afternoon. Naming it costs one line.
 *
 * Empty in every case where nothing was taken away: the shell exported none of the pair, or exported the
 * very value that resolved (CI, where the environment is the intended source and a line every run would
 * be noise). A key present in the base and absent from the child counts — that is `PITHY_OFFLINE` having
 * stripped it, which is worth the same sentence.
 */
export function overriddenCredentialKeys(
  base: NodeJS.ProcessEnv,
  child: Readonly<Record<string, string>>,
): readonly string[] {
  return CLOUDFLARE_CREDENTIAL_KEYS.filter((key) => {
    const inherited = base[key];
    return Boolean(inherited) && child[key] !== inherited;
  });
}
