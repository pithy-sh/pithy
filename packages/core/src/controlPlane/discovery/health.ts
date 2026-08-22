// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { z } from "zod";
import type { Capability, PithyHonoEnv } from "../../capability/capability";
import { InternalError } from "../../error/pithyError";
import {
  type CapabilityHealthReport,
  type HealthSummary,
  HealthSummaryKey,
  type HealthSummaryValue,
} from "./healthSummary";

/**
 * The seam a capability implements to contribute a health summary to its own manifest entry (#317).
 *
 * The vocabulary itself — what a key may be called, what it may hold, what it costs, and the four
 * states it travels in — is `./healthSummary`, and that argument is stated there in full. This is the
 * other half: the branded declaration a `Capability` carries, the assembly-time check that a key
 * inherits a scope its own routes already gate, and the per-request read that decides between a number,
 * a withholding and a failure.
 *
 * **The two are separate modules because the compiler follows a type-only edge (#430).** Everything
 * here needs `Capability`, `PithyHonoEnv` and `Context`, which reach D1, KV and Hono; nothing a browser
 * imports needs any of it. Leaving the wire vocabulary in this file put all of that one `import type`
 * away from every management client, through `adminRoute.ts`. Nothing in `./healthSummary` may import
 * this module, and `tooling/browser-scopes` is the gate that says so.
 */

/**
 * The brand only {@link defineCapabilityHealth} can produce.
 *
 * Module-local and never exported, so nothing outside this file can write it: the factory becomes the
 * **only** way to build the seam, and a declaration therefore cannot reach a manifest without having
 * been parsed. An inline object literal on `Capability.health` is a compile error, which is what stops
 * the next producer from re-inventing this with a key nothing validated — the failure mode every defect
 * class in this kit has had in common.
 *
 * `Symbol()` rather than `Symbol.for()`, unlike the seam's `ANY_VERIFIED_CALLER`: that one is a
 * requirement a route states and nobody may forge over the wire; this is a mark only this module applies.
 */
const healthSeam: unique symbol = Symbol("pithy.controlPlane.capabilityHealth");

/** What a capability declares and how it produces it. Built only by {@link defineCapabilityHealth}. */
export interface CapabilityHealth {
  /** The brand. Present only on a declaration that went through the factory, and never serialized. */
  readonly [healthSeam]: true;
  /** The closed vocabulary: every key this capability may report, parsed. */
  readonly keys: readonly HealthSummaryKey[];
  /** Produce every declared key for this request. Bounded by the declaration, never by adopter data. */
  readonly read: (c: Context<PithyHonoEnv>) => Promise<HealthSummary>;
}

/** The authoring shape — keys as written, before parsing. */
export interface CapabilityHealthInput {
  /** Every key this capability may report. At least one; an empty vocabulary is not a summary. */
  keys: readonly z.input<typeof HealthSummaryKey>[];
  /** Produce every declared key for this request. */
  read: (c: Context<PithyHonoEnv>) => Promise<HealthSummary>;
}

/**
 * Declare a capability's health summary. The one constructor, so every declaration in the tree is
 * parsed — kind against states, cost against the closed vocabulary, key against the name pattern.
 */
export function defineCapabilityHealth(input: CapabilityHealthInput): CapabilityHealth {
  if (input.keys.length === 0) {
    throw new InternalError({
      message: "A capability declared a health summary with no keys.",
      action: "Declare at least one key, or omit the health seam entirely.",
      detail: "defineCapabilityHealth received an empty key list; an empty vocabulary is not a summary.",
    });
  }
  const keys = input.keys.map((key) => HealthSummaryKey.parse(key));
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.key)) {
      throw new InternalError({
        message: "A capability declared the same health key twice.",
        action: "Give each key one declaration — the second silently decides what the first meant.",
        detail: `health key ${key.key} is declared more than once`,
      });
    }
    seen.add(key.key);
  }
  return { [healthSeam]: true, keys, read: input.read };
}

/** One capability's contribution, as the seam holds it between assembly and a request. */
export interface CapabilityHealthSource {
  /** Which capability contributes it — named in every refusal, because the fix is always in that package. */
  capability: string;
  /** Its closed vocabulary. */
  keys: readonly HealthSummaryKey[];
  /** Its producer. */
  read: (c: Context<PithyHonoEnv>) => Promise<HealthSummary>;
}

/**
 * Every composed capability's health contribution, checked at assembly.
 *
 * **The check is that a summary inherits a scope, never invents one**, and it is compared against a
 * different artifact than the one it polices: the capability's own `adminRoutes`. That is not a
 * tidiness rule. `pithy dashboard connect` offers an adopter the scopes it reads off `adminRoutes`, so
 * a key behind a scope no route requires is a number that could never be granted — permanently
 * withheld, with nothing an adopter could do about it, and no error anywhere to say why. Failing at
 * assembly turns that into a deploy that does not start.
 */
export function capabilityHealthSources(
  capabilities: readonly Capability[],
): ReadonlyMap<string, CapabilityHealthSource> {
  const sources = new Map<string, CapabilityHealthSource>();
  for (const capability of capabilities) {
    const health = capability.health;
    if (!health) continue;
    const gated = new Set((capability.adminRoutes ?? []).flatMap((route) => (route.scope ? [route.scope] : [])));
    for (const key of health.keys) {
      if (!gated.has(key.scope)) {
        throw new InternalError({
          message: "A capability's health summary is behind a scope none of its admin routes requires.",
          action: "Put the value behind a scope the capability already gates a read with.",
          detail: `capability ${capability.name} declares health key ${key.key} behind ${key.scope}, which no admin route of that capability requires — an adopter is never offered it, so the value could never be granted`,
        });
      }
    }
    sources.set(capability.name, { capability: capability.name, keys: health.keys, read: health.read });
  }
  return sources;
}

/** Refuse a produced summary that its declaration cannot name. Total over what a producer may return. */
function checked(source: CapabilityHealthSource, produced: HealthSummary): HealthSummary {
  const declared = new Map(source.keys.map((key) => [key.key, key]));
  for (const key of Object.keys(produced)) {
    if (!declared.has(key)) {
      throw new InternalError({
        message: "A capability reported a health value it never declared.",
        action: "Declare the key alongside the capability's routes, or stop reporting it.",
        detail: `capability ${source.capability} produced health key ${key}, which its declaration does not name`,
      });
    }
  }
  for (const key of source.keys) {
    const value = produced[key.key];
    if (value === undefined) {
      throw new InternalError({
        message: "A capability omitted a health value it declared.",
        action: "Produce every declared key, or remove the declaration.",
        detail: `capability ${source.capability} declares health key ${key.key} and produced nothing for it`,
      });
    }
    const ok =
      key.kind === "count"
        ? typeof value === "number" && Number.isInteger(value) && value >= 0
        : typeof value === "string" && (key.states ?? []).includes(value);
    if (!ok) {
      throw new InternalError({
        message: "A capability reported a health value its declaration does not permit.",
        action: "Report a whole non-negative number for a count, or a declared member for a state.",
        // The value itself, because it is a scalar the declaration already said may be published — and
        // knowing *which* value was refused is most of the diagnosis.
        detail: `capability ${source.capability} produced ${JSON.stringify(value)} for ${key.kind} key ${key.key}`,
      });
    }
  }
  return produced;
}

/**
 * One capability's summary for one caller.
 *
 * **The producer is not called when no key is permitted**, so a caller with no grant costs the adopter's
 * Worker nothing at all. When it *is* called, the whole of what it produced is checked before anything
 * is withheld: a producer must not be able to hide a violation behind a scope the caller happens to
 * lack.
 *
 * **A failure is caught here and goes no further.** The manifest is the read every other pane is built
 * from, so one capability's bad afternoon must cost that capability's number and nothing else. Both
 * kinds of failure land in the same state, because from a caller's side they are one fact — this
 * capability could not say: the producer threw, or what it produced its own declaration does not
 * permit. An author's mistake is not what this hides. The scope a key inherits, its name, its cost and
 * the brand on the declaration are all checked at assembly, so the shape of a declaration fails a
 * deploy rather than a request; what reaches here is data-dependent, which is the transient kind.
 *
 * **The caught error is dropped whole, and the `catch` takes no binding so that is visible rather than
 * asserted.** It may be a `PithyError` whose `detail` names a row, a key id, or a query — throw-site
 * context, which is exactly what a producer should put there and exactly what must not travel. Nothing
 * derived from it reaches the manifest, a log, or a response: what survives is that this capability
 * failed, and its name, which the manifest already carries in public. An adopter diagnoses it at their
 * own throw site, where the context is theirs and stays theirs.
 */
export async function readCapabilityHealth(
  source: CapabilityHealthSource | undefined,
  grantedScopes: readonly string[],
  produce: (source: CapabilityHealthSource) => Promise<HealthSummary>,
): Promise<CapabilityHealthReport> {
  if (!source) return { state: "undeclared" };
  const permitted = source.keys.filter((key) => grantedScopes.includes(key.scope));
  if (permitted.length === 0) return { state: "withheld" };
  let produced: HealthSummary;
  try {
    produced = checked(source, await produce(source));
  } catch {
    return { state: "unavailable" };
  }
  const visible: HealthSummary = {};
  for (const key of permitted) {
    // Present: `checked` refused anything the declaration does not name and anything it omits.
    visible[key.key] = produced[key.key] as HealthSummaryValue;
  }
  return { state: "reported", values: visible };
}
