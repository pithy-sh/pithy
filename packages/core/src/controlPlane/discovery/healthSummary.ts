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
 * What a count must be for its key to be nominal — a bound, in either direction or both.
 *
 * **Both are optional and at least one is required**, which is the whole of the shape. `atMost: 0` is
 * `secretsDueForRotation`, where zero is the good answer; `atLeast: 1` is a count of things that must
 * exist, where zero is the fault. A declaration carrying neither is a claim with no content, and one
 * carrying an inverted pair is a claim nothing can satisfy — both would make every value on that key
 * want attention forever, which is worse than declaring nothing.
 *
 * Inclusive at the edge. A cadence saying *no more than zero overdue* means zero is fine.
 */
export const HealthCountNominal = z
  .object({
    atMost: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("The largest nominal value, inclusive. Above it the value wants attention."),
    atLeast: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("The smallest nominal value, inclusive. Below it the value wants attention."),
  })
  .describe(
    "A count's nominal range: at least one bound, inclusive at its edge. Neither is a claim with no content; an inverted pair is one nothing can satisfy.",
  );
export type HealthCountNominal = z.output<typeof HealthCountNominal>;

/**
 * What a key claims a nominal value is, or null where it makes no claim at all.
 *
 * **Null is the default and stays supported forever.** Some measures genuinely have no good or bad
 * value — a count of things that simply exist — and a vocabulary that forced a claim would collect
 * invented ones. What must never happen is a client reading null as *fine*; {@link standingOf} answers
 * `unknowable` for it, and that is the point of this whole field.
 */
/*
  **These two are the shape; `HealthSummaryKey` is the gate.** Standalone, this accepts `{}` and `[]` —
  the rules that refuse them depend on `kind`, which lives on the key rather than here, so they are
  enforced in that object's refine. A consumer validating a nominal on its own gets the loose shape and
  should parse the whole key instead.
*/
export const HealthNominal = z
  .union([HealthCountNominal, z.array(z.string().min(1))])
  .nullable()
  .describe(
    "What this key's nominal value is: a bound for a `count`, the nominal members for a `state`, or null where the capability makes no claim. Which shape applies is decided by `kind`.",
  );
export type HealthNominal = z.output<typeof HealthNominal>;

/**
 * Whether a declared nominal fits the kind it was declared on.
 *
 * A free function rather than an inline predicate because the refine needs it before the object exists
 * and because `states` is read from the same key — a `state` key's nominal must name members that key
 * actually declares, or the claim is unverifiable: a producer can never send a value that matches it.
 *
 * Null is always suitable. That is the default, and a key that grades nothing is the common case.
 */
function nominalSuitsKind(kind: HealthValueKind, nominal: HealthNominal, states: readonly string[] | null): boolean {
  if (nominal === null) return true;
  if (kind === "count") {
    if (Array.isArray(nominal)) return false;
    const { atMost, atLeast } = nominal;
    // A bound with no side is a claim with no content; an inverted one is a claim nothing satisfies.
    if (atMost === undefined && atLeast === undefined) return false;
    return atMost === undefined || atLeast === undefined || atLeast <= atMost;
  }
  if (!Array.isArray(nominal) || nominal.length === 0) return false;
  // Every nominal member has to be one the key declares, or the claim is one no producer could satisfy.
  //
  // `states` is null only on a declaration the refine above this one has already refused — a `state`
  // key must declare a non-empty list. Answering `true` there reports the one real fault rather than
  // two, and this is never the only thing standing between a bad declaration and the wire.
  return states === null ? true : nominal.every((member) => states.includes(member));
}

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
    /*
      **#471. `summary` says what the value means; this says what it should be.**

      Without it a client holds a number, a scope, a cost and an English sentence, and cannot tell a
      good value from a bad one: `secretsDueForRotation: 0` is the good answer and a `verifiedSenders: 0`
      would be a fault, from declarations identical in every other field. A management client that
      rendered either as a finding was claiming a verdict the manifest never carried.

      `.default(null)` rather than required, and permanently: it is what makes every manifest built
      before this field parse unchanged, and it is the honest answer for a measure nobody grades.
    */
    nominal: HealthNominal.default(null).describe(
      "What a nominal value is for this key — a bound for a `count`, the nominal members for a `state`, or null where the capability makes no claim. A client reads null as `unknowable`, never as healthy.",
    ),
  })
  .refine((key) => (key.kind === "state" ? key.states !== null && key.states.length > 0 : key.states === null), {
    message: "A `state` key declares a non-empty closed list; a `count` key declares none.",
    path: ["states"],
  })
  /*
    The shape of `nominal` is decided by `kind`, exactly as `states` is one refine above.

    **Asserted both ways in the suite**, because a refine written for one direction admits the other —
    the lesson the `states` refine already records, and the reason this is a predicate over both rather
    than a check that a count's nominal is an object.
  */
  .refine((key) => nominalSuitsKind(key.kind, key.nominal, key.states), {
    message:
      "A `count` key's nominal is a bound with at least one satisfiable side; a `state` key's is a non-empty list of members it declares.",
    path: ["nominal"],
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

/**
 * Where one value stands against its own declaration — #471.
 *
 * Three answers, and the third is the reason this exists.
 *
 * - `nominal` — the value is what the capability said it should be.
 * - `attention` — it is not.
 * - `unknowable` — **nobody said what it should be**, so nothing can be concluded.
 *
 * **`unknowable` is never `nominal`, and a client must not collapse them.** A key that declares no
 * bound is a key nobody can grade; answering `nominal` for it would let a management client read
 * healthy because nothing told it otherwise, which is the defect this whole field was filed to remove
 * rather than relocate. #350 made the four report states a discriminated union for the same reason —
 * so a consumer that forgets the sick case gets a type error instead of a screen that lies — and this
 * is the same choice one level down.
 *
 * It is also the answer for a value whose **type** contradicts its `kind` — a string where a count was
 * declared. `checked()` refuses that on the producing side, but a client parses manifests from Workers
 * it does not control, and grading a value that is not the kind of thing being graded is inventing an
 * answer about it.
 *
 * **A `state` value outside its own `states` is a different case and is `attention`, deliberately.** It
 * is a string, so it is the kind of thing being graded; it is simply not one the capability said it
 * would send. Answering `unknowable` there would file a Worker reporting `storeState: "exploded"` under
 * *nothing can be concluded*, when what can be concluded is that something is wrong.
 */
export type HealthStanding = "nominal" | "attention" | "unknowable";

/** Where {@link HealthSummaryValue} stands against the key that declared it. See {@link HealthStanding}. */
export function standingOf(key: HealthSummaryKey, value: HealthSummaryValue): HealthStanding {
  const nominal = key.nominal;
  /*
    **`== null`, which is `undefined` as well, and the asymmetry is what made it a defect.**

    A key that reaches here without the field is one somebody built by hand and asserted into the type
    rather than parsed — `.default(null)` fills it on every parsed path. With `=== null` the `state`
    branch below still answered `unknowable`, because `!Array.isArray(undefined)` catches it, while this
    one fell through to `nominal.atMost` and threw. One malformed input, two behaviors, and the noisier
    of the two on the branch a client is likelier to hit.

    This function is exported, and this module's own doctrine is that a client parses manifests from
    Workers it does not control. Answering the question is what it is for; throwing is not an answer.
  */
  if (nominal == null) return "unknowable";
  if (key.kind === "count") {
    if (Array.isArray(nominal) || typeof value !== "number" || !Number.isInteger(value)) return "unknowable";
    // Inclusive at both edges — a cadence saying *no more than zero overdue* means zero is fine.
    if (nominal.atMost !== undefined && value > nominal.atMost) return "attention";
    if (nominal.atLeast !== undefined && value < nominal.atLeast) return "attention";
    return "nominal";
  }
  if (!Array.isArray(nominal) || typeof value !== "string") return "unknowable";
  return nominal.includes(value) ? "nominal" : "attention";
}

/**
 * Every value this capability reported that wants somebody's attention, in declaration order.
 *
 * `namedHealthValues` one filter later, and here rather than in every client so the filter is written
 * once. The three stateless reports answer empty: `undeclared`, `withheld` and `unavailable` are states
 * of the *report* rather than of any value, and folding one of them into a list of graded measures is
 * exactly the collapse #350 and #471 each exist to prevent — a withheld number is not a bad number, and
 * a failed read is not a finding about the thing that failed to be read.
 *
 * A value standing at `unknowable` is not here either. The list is what wants attention, and a measure
 * nobody grades cannot want it.
 *
 * **So an empty list is not a clean bill of health, and a client that renders it as one has rebuilt
 * #471 one layer up.** Five situations answer `[]`: nothing declared, withheld, unavailable, everything
 * nominal, and everything ungradeable. Three of those are *could not look* rather than *nothing is
 * wrong*. A surface that wants to tell them apart has what it needs — the report's own state separates
 * the first three, and mapping {@link namedHealthValues} through {@link standingOf} separates the last
 * two — but it has to ask, and this function deliberately does not answer it.
 */
export function healthAttention(descriptor: {
  healthKeys: readonly HealthSummaryKey[];
  health: CapabilityHealthReport;
}): NamedHealthValue[] {
  return namedHealthValues(descriptor).filter((named) => standingOf(named.key, named.value) === "attention");
}
