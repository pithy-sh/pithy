// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The one writer of a `wrangler.jsonc` stanza's `vars`.** Every var the CLI writes into a Worker's config goes
 * through here: `BASE_URL` from a domain or a feature's address, the identity vars a new project, a rename or a new
 * stanza stamps, a provisioning record, a Workflow host's deploy stamp, every var a Worker declares with
 * `defineVars`, and the `vars` block of a `wrangler.jsonc` written whole as text. `stanzaVars.test.ts` fails on a
 * write that does not.
 *
 * Each call mutates the live stanza, so `comment-json` keeps the comments on the block and its keys.
 */

import { BASE_URL_VAR, ENVIRONMENT_VAR } from "@pithy-sh/core/src/worker/identity";

/** A stanza: the top level of a `wrangler.jsonc` or one `env.<name>`. */
type Stanza = object;

/** A stanza's `vars` block, or `null` when it holds none or holds something that is not one. */
export function stanzaVarsOf(stanza: Stanza): Record<string, unknown> | null {
  const vars = (stanza as { vars?: unknown }).vars;
  return typeof vars === "object" && vars !== null && !Array.isArray(vars) ? (vars as Record<string, unknown>) : null;
}

/** Set one var, creating the block when the stanza has none. Returns whether the stanza changed. */
export function setStanzaVar(stanza: Stanza, name: string, value: unknown): boolean {
  let vars = stanzaVarsOf(stanza);
  if (vars === null) {
    vars = {};
    (stanza as { vars?: unknown }).vars = vars;
  } else if (Object.hasOwn(vars, name) && JSON.stringify(vars[name]) === JSON.stringify(value)) {
    return false;
  }
  vars[name] = value;
  return true;
}

/**
 * A `vars` block as `wrangler.jsonc` text, for a writer authoring a whole file rather than editing a parsed one: the
 * key line, one line per var, and the closing brace, each indented by `indent`, with no trailing comma.
 */
export function varsBlockText(vars: Readonly<Record<string, string>>, indent: string): string {
  const entries = Object.entries(vars).map(
    ([name, value]) => `${indent}  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
  );
  return [`${indent}"vars": {`, entries.join(",\n"), `${indent}}`].join("\n");
}

/** Remove one var. Returns whether the stanza held it. */
export function removeStanzaVar(stanza: Stanza, name: string): boolean {
  const vars = stanzaVarsOf(stanza);
  if (vars === null || !Object.hasOwn(vars, name)) return false;
  delete vars[name];
  return true;
}

/** The var `pithy vector provision` writes its provisioning record into, one environment's stanza at a time. */
export const VECTOR_PROVISIONED_VAR = "VECTOR_PROVISIONED";

/**
 * **The vars the CLI writes with a value of each stanza's own**, so the top level's value is dev's and never the
 * line an environment stanza copies.
 *
 * Each maps to the value a stanza for that environment holds, where the name alone says it, or `null` where only the
 * command that writes it can: `BASE_URL` comes from that environment's domain, and `VECTOR_PROVISIONED` from
 * provisioning that environment's index. A stanza without one of those has not had that command run for it yet,
 * which is not a stanza that dropped a var.
 */
export const PER_ENVIRONMENT_VARS: ReadonlyMap<string, ((env: string) => unknown) | null> = new Map<
  string,
  ((env: string) => unknown) | null
>([
  [ENVIRONMENT_VAR, (env) => env],
  [BASE_URL_VAR, null],
  [VECTOR_PROVISIONED_VAR, null],
]);
