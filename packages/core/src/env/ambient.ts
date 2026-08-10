// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ENVIRONMENT_VAR } from "../worker/identity";

/**
 * What the *ambient* environment says about the composition being assembled — the two questions a
 * capability may ask before it registers anything, and the one reader for both.
 *
 * ## Why a capability can ask this at all
 *
 * A Worker is handed its bindings per request, so `c.env` does not exist when `createBackend` calls a
 * capability's `routes()`. `process.env` does: with `nodejs_compat` and a compatibility date past
 * 2025-04-01 — every Worker `pithy init` scaffolds — workerd populates `process.env` from the script's
 * own `vars` and secrets, and it is populated at module scope, before the first request. Verified
 * against a real `wrangler dev`: at module scope `Object.keys(process.env)` is exactly the declared
 * vars.
 *
 * That is the whole reach of this module, and the limit is the interesting half:
 *
 * - **`ENVIRONMENT` is here**, because `pithy init` stamps it into every environment stanza of every
 *   Worker's `wrangler.jsonc` ({@link ENVIRONMENT_VAR}). A composition can therefore know it is `dev`
 *   without being told.
 * - **The host's environment is not here.** `CI=true` in the shell that ran `wrangler dev` does *not*
 *   appear inside the Worker — workerd replaces `process.env` with the bindings rather than merging.
 *   {@link ./ci.ts} carries that consequence and what is done about it.
 *
 * Read at call time, never captured at import: a module-scope snapshot is unstubbable in a test and
 * would freeze the answer for the life of an isolate that outlives a `.dev.vars` edit.
 */

/** A process environment as this module reads one — the shape of `process.env`, and nothing assumed of it. */
export type AmbientEnv = Readonly<Record<string, string | undefined>>;

/**
 * The ambient environment, or an empty one where there is no `process` at all.
 *
 * Guarded rather than assumed: this module is bundled into Workers, and a runtime without
 * `nodejs_compat` has no `process`. An empty environment answers "nothing was stamped", which is the
 * refusing answer everywhere it is used — a missing `process` must never read as `dev`.
 */
export function ambientEnv(): AmbientEnv {
  return (globalThis as { process?: { env?: AmbientEnv } }).process?.env ?? {};
}

/**
 * Whether an environment variable counts as **set**: any non-blank value, blank is no override.
 *
 * One rule, stated once. It is `PITHY_OFFLINE`'s (#218), and the reason it is not "`=== "true"`" is
 * that runners disagree — `true`, `1`, and an operator's own word all mean the same thing, and a
 * variable someone deliberately blanked (`CI=`) is the one case that means "no".
 */
export function ambientFlag(env: AmbientEnv, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

/**
 * The environment this composition was stamped for — `dev`, `staging`, `prod`, or an adopter's own —
 * and `undefined` where nothing stamped one.
 *
 * **`undefined`, never a defaulted `dev`.** The callers are gates, and a gate that assumes `dev` when
 * it was told nothing opens itself in exactly the deployment whose `wrangler.jsonc` lost the var.
 */
export function compositionEnvironment(env: AmbientEnv = ambientEnv()): string | undefined {
  const value = (env[ENVIRONMENT_VAR] ?? "").trim();
  return value.length > 0 ? value : undefined;
}
