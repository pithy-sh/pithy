// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ControlPlaneScope } from "../scope/scope";

/**
 * The health vocabulary a manifest carries and a management client renders (#317, #350).
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
 * with, and a caller without that scope gets no value at all rather than a zero.
 *
 * ## And a broken store is a fourth fact (#350)
 *
 * #317 got three states right and left the fourth to a reviewer, deliberately: a producer that throws
 * is neither a withheld number nor a zero, and returning null for it would have made a sick store
 * indistinguishable from one this caller may not look at. The reasoning was right. The behavior was
 * that the throw propagated, the whole manifest read failed, and one sick capability blanked Overview
 * for every capability beside it — with nothing on screen saying which one.
 *
 * So there are four, and they live on {@link CapabilityHealthReport}: `undeclared`, `withheld`,
 * `reported`, `unavailable`. The state rides on the value rather than beside it, so a consumer reaches
 * a number only by narrowing, and one that forgets the failure does not render a zero — it does not
 * compile.
 *
 * **Staleness.** These numbers are as old as the manifest a client cached. They are right for a rail
 * and must never be presented as live.
 *
 * ## Why this is not in `health.ts` (#430)
 *
 * It was, and that put the whole Workers data layer one type-only edge from a browser. `adminRoute.ts`
 * imports `healthReport` and `HealthSummaryKey` to describe a manifest entry; every capability's
 * control-plane scope declaration imports `AdminRoute` from `adminRoute.ts`; and `health.ts` imports
 * `Capability` and `PithyHonoEnv`, which reach `data/db.ts` and `kv/kv.ts`. Eight modules a browser is
 * meant to import were compiling `@cloudflare/workers-types`, `hono`, `kysely` and `kysely-d1` — 46 kit
 * files to declare five strings — and `coverage.test.ts`'s type-only rule was satisfied throughout,
 * because **the compiler follows a type-only edge exactly as it follows a value one**.
 *
 * So the seam is next door and this is the wire. This module's whole import list is `zod` and a scope,
 * and the split is along a line nothing crosses: not one symbol here needs a `Context`, a `Capability`
 * or an `InternalError`. `tooling/browser-scopes` compiles each scope declaration as a browser program
 * and fails on anything but `zod`, so the line is held by a gate rather than by this paragraph.
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
 * What one capability's summary is, for one caller. Four states, and the value carries which.
 *
 * A discriminated union rather than a nullable record with a flag beside it, and that is the whole
 * point of #350. A flag is the same information and the opposite property: correct for whoever
 * remembered to read it, and a zero for everybody else. Here the scalars are unreachable without
 * narrowing on `state`, so forgetting the sick case is a type error rather than a screen that says
 * everything is fine.
 *
 * - `undeclared` — the capability contributes no summary. Nothing to show, and nothing wrong.
 * - `withheld` — it declares one, and this connection was not granted the scope it sits behind. Read
 *   `healthKeys` beside this and a client can say a number exists that it may not see.
 * - `reported` — the values, each one named by a declaration that travels with it. Zero is one of these.
 * - `unavailable` — producing the summary failed. Not zero, not withheld, and never both.
 */
export const CapabilityHealthReport = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("undeclared").describe("This capability contributes no summary at all."),
      })
      .describe("A capability with nothing to report. Nothing to show, and nothing wrong."),
    z
      .object({
        state: z.literal("withheld").describe("A summary exists that this connection was not granted."),
      })
      .describe(
        "A declared summary this caller may not see. Read `healthKeys` beside it to say a number exists rather than to say there is none.",
      ),
    z
      .object({
        state: z.literal("reported").describe("The summary was produced and this caller may see it."),
        values: HealthSummary.describe("Each declared key this caller is entitled to, and its scalar. Zero is one."),
      })
      .describe("The numbers, each one named by a declaration that travels beside it in `healthKeys`."),
    z
      .object({
        state: z.literal("unavailable").describe("Producing this capability's summary failed on this read."),
      })
      .describe(
        "A summary that could not be produced. Deliberately empty: what the producer threw may name a row or a key, so nothing derived from it travels — there is nowhere to put it.",
      ),
  ])
  .describe(
    "What one capability's summary is, for one caller: nothing declared, declared and withheld, reported, or failed. The state is on the value, so a scalar is unreachable without narrowing.",
  );
export type CapabilityHealthReport = z.output<typeof CapabilityHealthReport>;

/** A manifest entry's health as the wire carries it: the #317 fields, plus the flag #350 added. */
export interface CapabilityHealthWire {
  /** The closed vocabulary this capability may report. Empty when it declares none. */
  healthKeys: readonly HealthSummaryKey[];
  /** The values this caller may see, or null when there are none to give. Null is never zero. */
  health: HealthSummary | null;
  /** Whether producing the summary failed on this read. */
  healthUnavailable: boolean;
}

/**
 * Read the four states off a manifest entry.
 *
 * **The failure flag is checked first and wins.** A Worker that sends both a failure and values is
 * describing a producer that did not finish, and reading what it sent anyway is reading whatever the
 * failure left behind.
 *
 * A Worker deployed before #350 sends no flag, which defaults to false, and lands on the three states
 * it already had. A Worker deployed before #317 sends neither field and lands on `undeclared`.
 */
export function healthReport(entry: CapabilityHealthWire): CapabilityHealthReport {
  if (entry.healthUnavailable) return { state: "unavailable" };
  if (entry.health) return { state: "reported", values: entry.health };
  return entry.healthKeys.length === 0 ? { state: "undeclared" } : { state: "withheld" };
}

/**
 * Put a report back on the wire.
 *
 * The one place the two fields are written, so a handler cannot set the values and forget the flag.
 * `undeclared` and `withheld` encode alike on purpose — `healthKeys` rides in the same entry and tells
 * them apart, which is the arrangement #317 chose and this does not disturb.
 */
export function healthWire(report: CapabilityHealthReport): {
  health: HealthSummary | null;
  healthUnavailable: boolean;
} {
  return {
    health: report.state === "reported" ? report.values : null,
    healthUnavailable: report.state === "unavailable",
  };
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
 *
 * **Only `reported` has values.** A withheld summary and a failed one both name nothing here, which is
 * right for a list of numbers — and it is why a surface that must say *why* there is no number reads
 * `state` rather than the length of this.
 */
export function namedHealthValues(descriptor: {
  healthKeys: readonly HealthSummaryKey[];
  health: CapabilityHealthReport;
}): NamedHealthValue[] {
  const health = descriptor.health;
  if (health.state !== "reported") return [];
  const named: NamedHealthValue[] = [];
  for (const key of descriptor.healthKeys) {
    const value = health.values[key.key];
    if (value !== undefined) named.push({ key, value });
  }
  return named;
}
