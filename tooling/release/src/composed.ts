// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { blankComments } from "@pithy-sh/core/src/text/comments";

/**
 * What a Worker is composed of, as a set — the thing `pithy add` must produce the same of however the
 * adds were ordered.
 *
 * ## The claim, and the weaker one it replaces
 *
 * `pithy-sh/dashboard`'s first-run suite asserted that two orderings of `pithy add` produce
 * **byte-identical** projects. That is wrong and was not merged: every writer in the CLI's
 * `capabilities/add.ts` appends, so two orderings legitimately produce the same set in a different
 * textual order, and a byte diff fails for an entirely benign reason. A gate that fails on correct
 * behavior is worse than no gate, because it gets switched off and takes the real assertions with it.
 *
 * What "additive" actually promises is that the **result** is the same: the same capabilities
 * registered, and the same bindings declared in the same environments, whichever order they arrived in.
 * That is what this extracts, and #486 is the argument for asserting it even though appending makes it
 * true today — *whether every writer appends* is the thing under test rather than a premise of it, and
 * it is the one promise in the capability contract that has never been observed to hold.
 *
 * ## The environment prefix is not decoration
 *
 * A binding that lands in `staging` and not in `prod` is a real difference even when the overall set of
 * binding names matches, and it is the shape a per-environment writer gets wrong. So a binding is
 * recorded as `<env>:<name>`, and the top-level stanza — which wrangler treats as the default
 * environment — is recorded under `dev`, the name Pithy gives it.
 */

/** Every `@pithy-sh/<name>` a Worker's `pithy.config.ts` imports, sorted and deduplicated. */
export function composedCapabilities(configSource: string): string[] {
  const found = new Set<string>();
  for (const match of blankComments(configSource).matchAll(/["'](@pithy-sh\/[a-z0-9-]+)/g)) {
    found.add(match[1] as string);
  }
  return [...found].sort();
}

/** One wrangler stanza, in the keys a binding can hang off. */
type Stanza = Record<string, unknown>;

/** The binding names one stanza declares, whatever kind they are. */
function bindingsOf(stanza: Stanza): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(stanza)) {
    if (key === "env" || !Array.isArray(value)) continue;
    for (const entry of value) {
      const name = (entry as { binding?: unknown })?.binding;
      if (typeof name === "string") found.push(name);
    }
  }
  // `version_metadata` and friends are objects rather than arrays, and carry a binding all the same.
  for (const [key, value] of Object.entries(stanza)) {
    if (key === "env" || Array.isArray(value) || typeof value !== "object" || value === null) continue;
    const name = (value as { binding?: unknown }).binding;
    if (typeof name === "string") found.push(name);
  }
  return found;
}

/**
 * Every binding a Worker's `wrangler.jsonc` declares, as `<env>:<name>`, sorted and deduplicated.
 *
 * The top level is `dev`: wrangler's unnamed stanza is the one `pithy dev` runs, and naming it makes a
 * binding present in one environment and absent from another visible as two different strings.
 */
export function composedBindings(wranglerSource: string): string[] {
  const config = JSON.parse(blankComments(wranglerSource)) as Stanza & { env?: Record<string, Stanza> };
  const found = new Set<string>();
  for (const name of bindingsOf(config)) found.add(`dev:${name}`);
  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    for (const name of bindingsOf(stanza)) found.add(`${env}:${name}`);
  }
  return [...found].sort();
}

/**
 * The composed result of one Worker: its capabilities and its bindings, in one sorted list.
 *
 * **It can be empty, and a caller must refuse an empty one rather than compare it.** That is the whole
 * lesson of the run this came from: an argv slip made both extractions empty, the comparison found two
 * empty lists equal, and the gate reported that the property held. A probe that silently reads nothing
 * produces a permanently green gate, which is the failure mode that hides exactly the class of bug this
 * is for. `composed.test.ts` asserts the empty answer is reachable, so the caller's floor is a real one.
 */
export function composedResult(configSource: string, wranglerSource: string): string[] {
  return [...composedCapabilities(configSource), ...composedBindings(wranglerSource)];
}
