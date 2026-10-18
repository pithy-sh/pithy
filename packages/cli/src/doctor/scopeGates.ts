// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { z } from "zod";

/**
 * **Whether this Worker's scope gates have anything to open them (#560).**
 *
 * `leaderboard`, `rating` and `ledger` gate their trusted-backend routes on an `AuthContext` scope, and
 * every one of those gates fails closed. With nothing composed to fill the array — `auth()` with no
 * `resolveScopes` — each answers 403 to every caller, forever, and the runtime cannot tell that from a
 * caller who simply is not trusted. It shipped that way for months, green, because nothing said so.
 *
 * So `pithy doctor` asks it of each Worker's own composition: which composed capabilities declare
 * `scopeGates`, and whether any declares `providesScopes`. It is the entitlement check's question, one seam
 * over, and it is answered the same way — from the capabilities as composed, never from a list kept here.
 *
 * **It reports and it does not fail the exit.** A project can legitimately compose `ledger` for its players'
 * balances and never move one from a backend, and a red `doctor` over a route nobody calls is a red nobody
 * can clear. What it must never be is silent, so a denying Worker is never collapsed to `healthy ✓`.
 */

/** One gate that answers 403 to everyone when nothing fills the scopes. */
export const ScopeGateFinding = z
  .object({
    capability: z.string().describe("The capability that mounts the gate."),
    scope: z.string().describe("The `AuthContext` scope it requires."),
    route: z.string().describe("The method and path it guards."),
  })
  .describe("One route gated on an `AuthContext` scope.");
export type ScopeGateFinding = z.infer<typeof ScopeGateFinding>;

/** What `doctor` learned about one Worker's scope gates. */
export const ScopeGateHealth = z
  .object({
    resolver: z
      .string()
      .nullable()
      .describe("The composed capability that fills `AuthContext.scopes` — `auth` with a `resolveScopes` — or null."),
    gates: z
      .array(ScopeGateFinding)
      .describe("Every scope-gated route this Worker composes, in composition order. Empty when it composes none."),
    denying: z.boolean().describe("True when there are gates and no resolver: every one of them refuses every caller."),
  })
  .describe("This Worker's scope gates against a scope resolver. Reported; never fails the exit.");
export type ScopeGateHealth = z.infer<typeof ScopeGateHealth>;

/** Read one Worker's composition for its scope gates and its resolver. Pure; never throws. */
export function scopeGateHealth(capabilities: readonly Capability[]): ScopeGateHealth {
  const resolver = capabilities.find((capability) => capability.providesScopes === true)?.name ?? null;
  const gates = capabilities.flatMap((capability) =>
    (capability.scopeGates ?? []).map((gate) => ({
      capability: capability.name,
      scope: gate.scope,
      route: gate.route,
    })),
  );
  return { resolver, gates, denying: gates.length > 0 && resolver === null };
}
