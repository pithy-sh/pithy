// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The Cloudflare credential keys pithy reads out-of-Worker (CLI, provisioning, live tests). These are
 * wrangler's own env-var names plus the Secrets Store id. From this single bootstrap token
 * (`CLOUDFLARE_API_TOKEN`) pithy **mints** the scoped, least-privilege tokens each use case needs —
 * most notably the secrets manager's runtime token, minted at provision time and written straight into
 * the Secrets Store, so no scoped token is ever supplied or kept here.
 *
 * **Where they are read from is not this module's answer any more (#182).** They are account-scoped, so
 * they live in `<config>/cloudflare.json` — or, since #206, in `<config>/cloudflare.<name>.json` when a
 * project's root config names its account. See `@pithy-sh/cli`'s `cloudflare/config`, which owns the
 * file, which file, the `process.env` overlay, and the split diagnostic. The names stay here because
 * both ends need them and the Worker-side package is the one both can import.
 *
 * **The overlay has an off switch, and it is not `PITHY_CONFIG_DIR` (#218).** Relocating the config
 * directory moves the *file*; these four names are still read out of the ambient environment, which is
 * how a CLI run in an empty scratch directory reached a real account off a token a shell had exported
 * hours earlier. `PITHY_OFFLINE` is the word that stops it, and it lives with the overlay it governs —
 * `PITHY_OFFLINE_ENV` in `@pithy-sh/cli`'s `cloudflare/config`. Anything outside the CLI that grows a
 * reason to read one of these names off `process.env` inherits that obligation with it.
 */
export const CLOUDFLARE_ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "SECRETS_STORE_ID",
  "R2_CREDENTIALS",
] as const;

/**
 * Which of {@link CLOUDFLARE_ENV_KEYS} an environment actually carries a value for. The one place that
 * list is turned into a check.
 *
 * **Non-empty, not merely present.** `vitest.shared.ts`'s `NO_ACCOUNT` pins all four keys to `""`, and
 * the `process.env` overlay in `@pithy-sh/cli`'s `cloudflare/config` already reads a blank as unset. A
 * predicate keying on presence would report every guarded unit project as leaking.
 *
 * **This module is bundled into workerd as well as run on the host, and that is why it imports nothing.**
 * The repository-root `vitest.workers.setup.ts` imports this function relatively and every workers
 * project loads it, so a `node:` import here breaks seventeen suites at collection. `vitest.shared.ts`
 * already leans on the same property for {@link CLOUDFLARE_ENV_KEYS} and says so. Nothing gates the
 * import half — `@pithy-sh/core` has `worker-safety.test.ts` and this package has no equivalent — so it
 * is a constraint a reader has to be told, which is what this paragraph is. The other half is gated:
 * `packages/cli/src/ci/testIsolation.test.ts` walks what every workers config imports, so this module
 * is in that scan and a `process.env` read here is red (#437).
 */
export function visibleCredentialKeys(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return CLOUDFLARE_ENV_KEYS.filter((key) => (env[key] ?? "").length > 0);
}

/**
 * Parse a `.dev.vars` file body into a map: `KEY=value` lines, `#` comments and blanks skipped, and
 * a single layer of surrounding quotes stripped. Pure — the caller owns the file read.
 */
export function parseDevVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return vars;
}

/**
 * The keys that only mean anything **together, from one account**: the account id, and a token minted in
 * that account. Deliberately just the pair.
 *
 * The other {@link CLOUDFLARE_ENV_KEYS} stay out, because each fails loudly and immediately when it comes
 * from the wrong account: a store id this account does not hold 404s on the first call, and an S3 key
 * that does not belong to the account in the endpoint will not sign. Only the pair can *quietly* succeed
 * somewhere unintended — a live token against another account's id is a 403 or an empty listing much
 * later — so only the pair is a group. That is the whole test for membership.
 *
 * **A whole file can be the wrong account too.** This pair is the *half-file, half-environment* case; one
 * level up, a file that is entirely coherent in itself can belong to a different company than the project
 * reading it, which is what a project's `cloudflare.accountName` and its `accountId` pin answer (#206).
 *
 * `SECRETS_STORE_ID` used to be excluded on the grounds that it is "routinely passed per environment
 * while the pair sits in the file". That was never true: Cloudflare permits **one Secrets Store per
 * account**, so nothing about the id is per-environment, and it now sits in `cloudflare.json` beside the
 * pair for exactly that reason (#182). The conclusion was right; the stated reason was not.
 */
export const CLOUDFLARE_CREDENTIAL_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;
