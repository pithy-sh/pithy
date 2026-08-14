// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { z } from "zod";
import type { Capability, PithyHonoEnv } from "../../capability/capability";
import { InternalError } from "../../error/pithyError";
import { ControlPlaneScope } from "../scope/scope";

/**
 * The bounded health summary a capability contributes to its own manifest entry (#317).
 *
 * **The count is not the expensive part. The round trip is.** A management client that wants to say
 * "3 secrets need rotating" beside a rail already read the manifest; making it call again — once per
 * capability it wants a number from, against a customer's production Worker, on every screen load —
 * spends a credential per number nobody has asked for yet.
 *
 * The manifest is the right place because it already carries `version` per capability, and a version is
 * a fact about a capability's *state* rather than about its routes. Nobody discovers anything from it;
 * it is there because a management client needs it and a second call would be wasteful. This is the
 * same argument, already accepted once.
 *
 * ## What keeps it from becoming a data API
 *
 * Three rules, and every one of them is in the type rather than in a comment:
 *
 * 1. **Scalars only.** {@link HealthSummaryValue} is `number | string` and nothing else, so a
 *    projection, a row, or a list does not compile — {@link HEALTH_SUMMARY_IS_SCALAR_ONLY} fails the
 *    build the moment somebody widens it.
 * 2. **A closed vocabulary per capability**, declared alongside its routes. A produced key nobody
 *    declared is refused; the manifest never carries a number a client cannot name.
 * 3. **Nothing that costs a query to produce.** {@link HealthValueCost} has `memory` and `indexed` and
 *    no third member, so a value that would need a table scan cannot be declared at all. A count that
 *    scans on every manifest read has moved the cost rather than removed it, and the manifest is the
 *    most frequently fetched thing this seam serves.
 *
 * ## A withheld number and a zero are different facts
 *
 * A count is less sensitive than the thing it counts, but "3 secrets need rotating" is still a fact
 * about somebody's security posture. So a key inherits a scope the capability *already* gates a read
 * with, and a caller without that scope gets no value at all rather than a zero. The manifest reports
 * both halves — `healthKeys` says what exists, `health` says what this caller may see — so three states
 * are distinguishable: nothing declared, declared and withheld, declared and zero.
 *
 * **Staleness.** These numbers are as old as the manifest a client cached. They are right for a rail
 * and must never be presented as live.
 */

/** A health key's name: one camelCase token, so it reads as a field and never as a path or an id. */
const HEALTH_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

/** What kind of scalar a key reports. */
export const HealthValueKind = z
  .enum(["count", "state"])
  .describe(
    "What kind of scalar this key reports: a `count` (a whole non-negative number) or a `state` (one member of a closed list). There is no third kind, because a third kind is how a summary becomes a projection.",
  );
export type HealthValueKind = z.output<typeof HealthValueKind>;

/**
 * What producing one value costs on a manifest read.
 *
 * **There is deliberately no member for a scan.** That is the whole constraint expressed as a
 * vocabulary: a capability whose number would need one cannot state its cost, so it cannot declare the
 * key, so the manifest stays cheap by construction rather than by everybody remembering.
 */
export const HealthValueCost = z
  .enum(["memory", "indexed"])
  .describe(
    "What this value costs to produce on a manifest read: `memory` for something already in the Worker's hands, `indexed` for a lookup an index answers and whose bound is a declaration rather than the adopter's data. No member names a scan, so a value that would need one cannot be declared.",
  );
export type HealthValueCost = z.output<typeof HealthValueCost>;

/**
 * One value a summary may carry. A number or a member of a declared enum — never anything else.
 *
 * This is the rule the issue asked to be in the type: `number | string` has no room for a row, an id, a
 * nested object, or a collection that grows with an adopter's data.
 */
export const HealthSummaryValue = z
  .union([z.number(), z.string()])
  .describe(
    "One scalar: a number, or a member of the closed list its key declares. Nothing else is representable — no names, no ids, no rows, no nested objects.",
  );
export type HealthSummaryValue = z.output<typeof HealthSummaryValue>;

/** Anything that is not a scalar. Named as a type so the tripwire below is a list to delete from. */
type NonScalar = object | ((...args: never[]) => unknown);

/**
 * `true` while `T` is scalars only, `never` the moment it admits anything else — so the assignment
 * below stops compiling if {@link HealthSummaryValue} is ever widened.
 *
 * The tuple wrapper is not decoration: a bare `Extract<...> extends never` distributes over a union and
 * would answer `true` for every member, which is the one way this check could quietly pass.
 */
export type ScalarOnly<T> = [Extract<T, NonScalar>] extends [never] ? true : never;

/** The compile-time half of "scalars only". Widen the value type and this line names the file. */
export const HEALTH_SUMMARY_IS_SCALAR_ONLY: ScalarOnly<HealthSummaryValue> = true;

/**
 * One key a capability may report, declared alongside its routes.
 *
 * `scope` is **not nullable**, unlike an admin route's. A route may need only a verified caller — the
 * seam's `ping` does — but a number about somebody's posture never may, and an optional field here is a
 * field somebody forgets.
 */
export const HealthSummaryKey = z
  .object({
    key: z
      .string()
      .regex(HEALTH_KEY_PATTERN, "A health key is one camelCase token — `secretsDueForRotation`.")
      .describe("The key this value appears under in the capability's summary. One camelCase token."),
    kind: HealthValueKind.describe("Whether the value is a count or a member of a closed list."),
    states: z
      .array(z.string().min(1))
      .nullable()
      .describe(
        "Every value a `state` key may take, so a client can render each one it knows and nothing for one it does not. Null for a `count`, and required for a `state`: an enum with no members is a string field wearing a costume.",
      ),
    scope: ControlPlaneScope.describe(
      "The scope this value is behind — one the capability's own admin routes already require, never a new one. A caller without it gets no value rather than a zero.",
    ),
    cost: HealthValueCost.describe("What producing this value costs on a manifest read."),
    summary: z
      .string()
      .min(1)
      .describe("One line saying what the number means, for a client to render beside it without knowing the key."),
  })
  .refine((key) => (key.kind === "state" ? key.states !== null && key.states.length > 0 : key.states === null), {
    message: "A `state` key declares a non-empty closed list; a `count` key declares none.",
    path: ["states"],
  })
  .describe(
    "One bounded scalar a capability contributes to its manifest entry: what it is called, what it may be, what it costs, and which scope it is behind.",
  );
export type HealthSummaryKey = z.output<typeof HealthSummaryKey>;

/**
 * A capability's summary as the manifest carries it: declared key → scalar.
 *
 * A record rather than a closed object, because the vocabulary is federated the way scopes and audit
 * actions are. **Parsing tolerates a key it has never heard of on purpose** — a client reading a newer
 * Worker must render the unknown one as nothing rather than fail the whole manifest.
 */
export const HealthSummary = z
  .record(z.string(), HealthSummaryValue)
  .describe(
    "One capability's health summary: each declared key to its scalar. Unknown keys parse rather than throw, so a client of an older build renders what it knows and nothing for the rest.",
  );
export type HealthSummary = z.output<typeof HealthSummary>;

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
 * One capability's summary for one caller, or null when there is none to give.
 *
 * Null covers both "declares nothing" and "declares something this caller may not see", and the
 * manifest keeps them apart by reporting `healthKeys` beside it. What null never means is zero.
 *
 * **The producer is not called when no key is permitted**, so a caller with no grant costs the adopter's
 * Worker nothing at all. When it *is* called, the whole of what it produced is checked before anything
 * is withheld: a producer must not be able to hide a violation behind a scope the caller happens to
 * lack.
 */
export async function readCapabilityHealth(
  source: CapabilityHealthSource | undefined,
  grantedScopes: readonly string[],
  produce: (source: CapabilityHealthSource) => Promise<HealthSummary>,
): Promise<HealthSummary | null> {
  if (!source) return null;
  const permitted = source.keys.filter((key) => grantedScopes.includes(key.scope));
  if (permitted.length === 0) return null;
  const produced = checked(source, await produce(source));
  const visible: HealthSummary = {};
  for (const key of permitted) {
    // Present: `checked` refused anything the declaration does not name and anything it omits.
    visible[key.key] = produced[key.key] as HealthSummaryValue;
  }
  return visible;
}

/** One value with the declaration that says how to render it. */
export interface NamedHealthValue {
  /** The declaration — its kind, its closed list, what it means, and what it cost. */
  key: HealthSummaryKey;
  /** The scalar reported for it. */
  value: HealthSummaryValue;
}

/**
 * Pair a capability's reported values with their declarations, dropping any value nothing declares.
 *
 * This is how "an unknown summary key is renderable as nothing rather than as an error" is real rather
 * than aspirational: a client renders what this returns, so a key from a Worker newer than its
 * declaration simply is not in the list.
 */
export function namedHealthValues(descriptor: {
  healthKeys: readonly HealthSummaryKey[];
  health: HealthSummary | null;
}): NamedHealthValue[] {
  const health = descriptor.health;
  if (!health) return [];
  const named: NamedHealthValue[] = [];
  for (const key of descriptor.healthKeys) {
    const value = health[key.key];
    if (value !== undefined) named.push({ key, value });
  }
  return named;
}
