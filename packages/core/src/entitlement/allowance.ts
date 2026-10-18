// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { PithyHonoEnv } from "../capability/capability";
import { InternalError, messageOf } from "../error/pithyError";
import type { MeterLimit } from "./entitlement";

/**
 * The allowance readers — how much the current caller may have, and whether a switch is on.
 *
 *   const seats = await quota(c, "seats");                  // number, or null for unlimited
 *   if (seats !== null && (await countMembers(orgId)) >= seats) throw new SeatLimitReached(…);
 *   if (await feature(c, "auditExport")) { … }               // boolean, never null
 *
 * **Neither takes an entitlement key, and that is the point.** A route does not know which tier the
 * caller's holder is on, and during an upgrade overlap it holds two. The provider resolves across every
 * key the holder has and answers the higher, so an adopter compares numbers and never ranks tiers.
 *
 * **Read, never enforced.** A quota denies nothing on its own and a feature set to `false` denies
 * nothing either — `requireEntitlement` still gates on the key alone. What a number means for a request
 * is the adopter's code to decide, because only the adopter can count what it owns.
 *
 * **They live in core for the reason `requireEntitlement` does.** A reader that arrived with
 * `@pithy-sh/payments` would be absent when payments is, and a route reading an allowance must then fail
 * rather than read something. So with no provider composed — or one that declares no allowances — both
 * throw `core/internal` naming the gap. Never `0`, which is a paywall shut for a reason nobody can see;
 * never unlimited, which is a paywall that does not exist.
 */

/** The refusal when nothing on the request can answer an allowance. The adopter's wiring, so `core/internal`. */
function noProvider(c: Context<PithyHonoEnv>, kind: "quota" | "feature", name: string): InternalError {
  const provider = c.var.entitlements?.provider ?? null;
  return new InternalError({
    message: `No ${kind} "${name}" can be resolved here.`,
    action: "Compose a payments capability that declares its entitlements in this Worker's pithy.config.ts.",
    detail:
      provider === null
        ? `no entitlement provider is composed, so ${kind}("${name}") has nothing to read.`
        : `${provider} resolves entitlements and declares no allowances, so ${kind}("${name}") has nothing to read.`,
  });
}

/** How many of `name` the caller's holder may have: a whole number, or `null` for unlimited. */
export async function quota(c: Context<PithyHonoEnv>, name: string): Promise<number | null> {
  const resolver = c.var.entitlements;
  if (!resolver?.quota) throw noProvider(c, "quota", name);
  return resolver.quota(name);
}

/** Whether `name` is on for the caller's holder. Always a boolean. */
export async function feature(c: Context<PithyHonoEnv>, name: string): Promise<boolean> {
  const resolver = c.var.entitlements;
  if (!resolver?.feature) throw noProvider(c, "feature", name);
  return resolver.feature(name);
}

/**
 * The ceiling a capability enforces on a meter it counts itself, for the current caller.
 *
 * **No provider, or one that binds nothing to this meter, is `{ enforced: false }`** — and the capability
 * keeps its own configured ceiling. Enforcement is opt-in per meter because a cap that arrives by surprise
 * breaks an adopter who was already over it.
 *
 * **A provider that throws refuses, and logs.** Storage already says which way round to err: over-counting
 * briefly and reclaiming is the right way round, and under-counting has no recovery. Treating a failed read
 * as unenforced would hand a customer an unbounded allowance for as long as the read kept failing. The cost
 * is real and is stated rather than discovered: our bug becomes a refused write for a paying customer.
 * Enforcement being opt-in is what bounds it — an adopter who would rather over-serve leaves the meter
 * advisory.
 */
export async function meterLimit(c: Context<PithyHonoEnv>, meter: string): Promise<MeterLimit> {
  const resolver = c.var.entitlements;
  if (!resolver?.meterLimit) return { enforced: false };
  try {
    return await resolver.meterLimit(meter);
  } catch (error) {
    c.var.log?.error("meter limit resolution failed", { provider: resolver.provider, meter, cause: messageOf(error) });
    throw new InternalError({
      message: "Usage could not be checked, so nothing was written.",
      action: "Read the preceding log line for why the allowance read failed.",
      detail: `${resolver.provider} threw resolving the ${meter} meter's ceiling; refusing rather than serving unbounded.`,
    });
  }
}
