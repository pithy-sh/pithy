// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  CONFIG_CONSTANTS,
  type ConfigConstant,
  type ConfigConstantRef,
  type ConfigOption,
  type ConfigOptionValue,
} from "@pithy-sh/core/src/capability/manifest";

/**
 * Which value a capability's option is written with: the adopter's override, the scaffold's constant, or
 * the manifest's literal default — decided once, for `pithy add` and `pithy upgrade` alike.
 *
 * **The rule this exists for: no capability asks an adopter to write down an origin.** Every one that
 * did got production's origin written into staging, silently and separately — `auth.baseURL` mailed
 * staging's testers magic links into production, `email.baseUrl` unsubscribed them there, and the Stripe
 * return URLs landed a staging payer on a production account that had bought nothing. Three capabilities,
 * one mistake, three discoveries on three different days, which is the shape that says the fix does not
 * belong inside any one capability (#256).
 *
 * So an option whose value is an origin names `publicOrigin` in its manifest and the writers render
 * `PUBLIC_ORIGIN` — the constant `pithy init` scaffolds, `originFor(compositionEnvironment(), DOMAINS)`,
 * which follows the environment the Worker is composing in and falls back to the local origin rather than
 * to another environment's.
 */

/**
 * The declaration a scaffolded config makes: `export const PUBLIC_ORIGIN = …`, at the top level.
 *
 * `export` is optional in the pattern and present in the scaffold — the constant is exported so an
 * adopter's own code can build a link against the same origin, and so that a config composing no
 * capability that takes one does not fail its own `biome check` on an unused variable.
 */
function declarationPattern(constant: ConfigConstant): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${CONFIG_CONSTANTS[constant]}\\b`, "m");
}

/**
 * Whether this Worker's `pithy.config.ts` actually declares the constant.
 *
 * Checked rather than assumed, because a project scaffolded before the constant existed does not have it
 * — and writing `baseURL: PUBLIC_ORIGIN` into a config with no such identifier trades a hardcoded origin
 * for a config that does not compile. The literal default is what those projects keep getting, and
 * `pithy upgrade` starts writing the constant the day the adopter adds it.
 *
 * Line-anchored, and on a declaration keyword rather than the bare name: the identifier appears in every
 * option line this writer has already written, and a substring match would read a *use* as a
 * declaration and hand the next capability a name still not defined anywhere.
 */
export function declaresConstant(source: string, constant: ConfigConstant): boolean {
  return declarationPattern(constant).test(source);
}

/**
 * What to render for one option, given the config it is being written into.
 *
 * **An override always wins.** `--set baseURL=https://…` and a prompt answer are an adopter saying they
 * want a literal, and that is a legitimate thing to want — a Worker fronted by something Pithy does not
 * know about has an origin no derivation can produce. What is not legitimate is *defaulting* to one.
 */
export function optionValue(
  option: ConfigOption,
  source: string,
  override: ConfigOptionValue | undefined,
): ConfigOptionValue | ConfigConstantRef {
  if (override !== undefined) return override;
  if (option.constant && declaresConstant(source, option.constant)) return { constant: option.constant };
  return option.default;
}
