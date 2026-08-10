// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type AmbientEnv, ambientEnv, ambientFlag } from "./ambient";

/**
 * Is this continuous integration? One read, one rule, one place — the convention starts here.
 *
 * Nothing in this repository read `CI` before #243, so this is the declaration rather than a fourth
 * copy of one. It exists because a gate that inlines `!!process.env.CI` at the point it guards is a
 * gate whose meaning is re-decided by whoever writes the next one.
 *
 * ## What counts as set
 *
 * **Any non-blank value.** `CI=true`, `CI=1`, and `CI=woodpecker` are all CI; `CI=` (set but empty,
 * which some runners do) and an absent `CI` are not. That is `PITHY_OFFLINE`'s rule (#218) applied
 * unchanged, rather than a second rule for a second variable — see {@link ambientFlag}.
 *
 * ## Why anything reads it
 *
 * CI is where an unsupervised capability is most reachable and least watched. A `dev` composition is
 * exactly what CI boots — integration suites, packaging checks, `pithy dev` itself — so "not `dev`"
 * does not cover CI, and CI is not production, so neither signal implies the other. Anything gated on
 * both asks twice, in two statements: an `||` folded into one expression is one edit from an `&&`, and
 * the failure mode is a session-minting endpoint that answers.
 *
 * ## Where it can be read, and where it cannot
 *
 * In the CLI, and in anything else running under Node, this is the host's own `CI`. **Inside a Worker
 * it is not**: workerd populates `process.env` from the script's bindings and nothing else, so the
 * shell variable does not cross that boundary (see {@link ./ambient.ts}). A Worker-side gate is
 * therefore only as truthful as what started the Worker — which is why `pithy dev` forwards `CI` into
 * every Worker it launches as a var, and why a gate that depends on this must also carry a second,
 * independent refusal that needs no forwarding.
 */

/** The variable every CI runner sets without configuration. The name is not ours to choose. */
export const CI_ENV = "CI";

/** Whether this process is running under continuous integration. Any non-blank `CI`; blank is not CI. */
export function isContinuousIntegration(env: AmbientEnv = ambientEnv()): boolean {
  return ambientFlag(env, CI_ENV);
}
