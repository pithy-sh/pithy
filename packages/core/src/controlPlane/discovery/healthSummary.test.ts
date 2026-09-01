// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  type CapabilityHealthReport,
  HEALTH_SUMMARY_IS_SCALAR_ONLY,
  HealthSummaryKey,
  type HealthSummaryKey as HealthSummaryKeyOut,
  healthAttention,
  healthReport,
  healthWire,
  namedHealthValues,
  standingOf,
} from "./healthSummary";

/**
 * The half of the health seam a manifest carries and a client renders (#317, #350, #430).
 *
 * These cases used to live in `health.test.ts` and moved with the symbols they cover. The split is not
 * tidiness: a module a browser may import must reach no module that needs the Workers runtime, and
 * `adminRoute.ts` — which every capability's scope declarations import for its `AdminRoute` type — used
 * to reach `Capability`, `PithyHonoEnv` and D1 through this vocabulary. Nothing here knows what a
 * `Context` is, and the tests are the same shape as the module: `zod`, a scope, and no seam.
 */

/** A key as a capability writes one, before parsing. */
type KeyInput = z.input<typeof HealthSummaryKey>;

/** A declaration a capability would write: one count, behind the scope its own read is behind. */
const dueForRotation: KeyInput = {
  key: "secretsDueForRotation",
  kind: "count",
  states: null,
  scope: "secrets:status:read",
  cost: "indexed",
  summary: "Secrets past the rotation cadence their registry entry declares.",
};

/** A second declaration, an enum rather than a count — the other half of "scalars only". */
const storeState: KeyInput = {
  key: "storeState",
  kind: "state",
  states: ["ready", "degraded"],
  scope: "secrets:status:read",
  cost: "memory",
  summary: "Whether the store answered its own liveness question.",
};

describe("a declaration names one camelCase key and states what it may hold", () => {
  test("a count carries no states, and a state carries a closed list", () => {
    expect(HealthSummaryKey.parse(dueForRotation).states).toBeNull();
    expect(HealthSummaryKey.parse(storeState).states).toEqual(["ready", "degraded"]);
  });

  test("the refine works both ways, which is the only way it means anything", () => {
    // A `state` with no vocabulary is a string field wearing a costume; a `count` with one is a number
    // pretending to have members. Both directions are asserted because a refine written for one is a
    // refine that admits the other.
    expect(() => HealthSummaryKey.parse({ ...storeState, states: null })).toThrow();
    expect(() => HealthSummaryKey.parse({ ...storeState, states: [] })).toThrow();
    expect(() => HealthSummaryKey.parse({ ...dueForRotation, states: ["a"] })).toThrow();
  });

  test("a key that is not one camelCase token is refused, so it never reads as a path or an id", () => {
    for (const key of ["secrets:due", "secrets due", "SecretsDue", "secrets.due", ""]) {
      expect(() => HealthSummaryKey.parse({ ...dueForRotation, key }), key).toThrow();
    }
  });

  test("a cost the vocabulary cannot name is refused, so a table scan cannot be declared", () => {
    // The vocabulary has no member for a scan. That is the constraint expressed as a list rather than
    // as a rule anybody has to remember: a value whose cost cannot be stated as bounded is a value that
    // does not belong on the most frequently fetched read this seam serves.
    expect(() => HealthSummaryKey.parse({ ...dueForRotation, cost: "scan" })).toThrow();
  });

  test("the scalar-only tripwire is armed", () => {
    // It is a compile-time assertion, and a compile-time assertion nothing imports is a file that can be
    // deleted without a red build. Reading it here is what keeps it in a program.
    expect(HEALTH_SUMMARY_IS_SCALAR_ONLY).toBe(true);
  });
});

describe("the four states round-trip the wire, and an older Worker still lands on the right one", () => {
  const keys = [HealthSummaryKey.parse(dueForRotation)];

  test("each state encodes and decodes back to itself", () => {
    const reports: CapabilityHealthReport[] = [
      { state: "undeclared" },
      { state: "withheld" },
      { state: "reported", values: { secretsDueForRotation: 0 } },
      { state: "unavailable" },
    ];
    for (const report of reports) {
      // `undeclared` and `withheld` encode alike; `healthKeys` rides in the same entry and tells them
      // apart, which is the arrangement #317 chose.
      const declared = report.state === "undeclared" ? [] : keys;
      expect(healthReport({ healthKeys: declared, ...healthWire(report) })).toEqual(report);
    }
  });

  test("a Worker deployed before #350 sends no flag and lands on the three states it had", () => {
    expect(healthReport({ healthKeys: [], health: null, healthUnavailable: false })).toEqual({ state: "undeclared" });
    expect(healthReport({ healthKeys: keys, health: null, healthUnavailable: false })).toEqual({ state: "withheld" });
    expect(healthReport({ healthKeys: keys, health: { secretsDueForRotation: 0 }, healthUnavailable: false })).toEqual({
      state: "reported",
      values: { secretsDueForRotation: 0 },
    });
  });

  test("a Worker sending both a failure and values is read as the failure", () => {
    // Not a shape this seam produces, and exactly why it is pinned: whatever a broken producer left in
    // the values is not an answer, and reading it would be reading the wreckage.
    expect(healthReport({ healthKeys: keys, health: { secretsDueForRotation: 9 }, healthUnavailable: true })).toEqual({
      state: "unavailable",
    });
  });
});

describe("a client renders an unknown key as nothing", () => {
  test("a value with no declaration beside it is dropped rather than guessed at", () => {
    // A newer Worker reporting a key this client has never heard of must render as nothing. It has a
    // declaration, so it renders generically; a value with *no* declaration is not renderable at all.
    const named = namedHealthValues({
      healthKeys: [HealthSummaryKey.parse(dueForRotation)],
      health: { state: "reported", values: { secretsDueForRotation: 3, somethingNewer: 9 } },
    });
    expect(named).toEqual([{ key: HealthSummaryKey.parse(dueForRotation), value: 3 }]);
  });

  test("a withheld summary and a failed one both name nothing", () => {
    const declared = [HealthSummaryKey.parse(dueForRotation)];
    expect(namedHealthValues({ healthKeys: declared, health: { state: "withheld" } })).toEqual([]);
    expect(namedHealthValues({ healthKeys: declared, health: { state: "unavailable" } })).toEqual([]);
    expect(namedHealthValues({ healthKeys: declared, health: { state: "undeclared" } })).toEqual([]);
  });
});

/**
 * **A declaration says what a value means; `nominal` says what it should be — #471.**
 *
 * Without it no client can tell a good number from a bad one. `secretsDueForRotation: 0` is the good
 * answer and a `verifiedSenders: 0` would be a fault, from declarations that are otherwise identical —
 * so a management client rendering either as a finding is claiming a verdict the manifest never carried.
 * `pithy-sh/dashboard` shipped exactly that, under a heading reading `Health`, before this landed.
 *
 * The field is optional forever. Some measures genuinely have no good value, and forcing a claim would
 * produce invented ones.
 */
describe("a key may declare what a nominal value is, and most do not", () => {
  test("every declaration that predates the field still parses, and claims nothing", () => {
    // The compatibility half, stated over the two fixtures this file already had. `.default(null)` is
    // what makes a manifest built before #471 parse unchanged rather than fail on a missing field.
    expect(HealthSummaryKey.parse(dueForRotation).nominal).toBeNull();
    expect(HealthSummaryKey.parse(storeState).nominal).toBeNull();
  });

  test("a count declares a bound, and a state declares which members are nominal", () => {
    expect(HealthSummaryKey.parse({ ...dueForRotation, nominal: { atMost: 0 } }).nominal).toEqual({ atMost: 0 });
    expect(HealthSummaryKey.parse({ ...storeState, nominal: ["ready"] }).nominal).toEqual(["ready"]);
  });

  test("**the shape is decided by `kind`, and the refine is asserted both ways**", () => {
    // A refine written for one admits the other — the lesson the `states` refine above this file
    // already records, applied to the field that arrived after it.
    expect(() => HealthSummaryKey.parse({ ...dueForRotation, nominal: ["ready"] })).toThrow();
    expect(() => HealthSummaryKey.parse({ ...storeState, nominal: { atMost: 0 } })).toThrow();
  });

  test("a count's bound has to bound something, and has to be satisfiable", () => {
    // `{}` is a claim with no content, and an inverted pair is a claim nothing can satisfy. Both are
    // declarations that would make `standingOf` answer `attention` for every value forever.
    expect(() => HealthSummaryKey.parse({ ...dueForRotation, nominal: {} })).toThrow();
    expect(() => HealthSummaryKey.parse({ ...dueForRotation, nominal: { atLeast: 5, atMost: 2 } })).toThrow();
    // And the satisfiable pair is accepted, so the rule above is a bound rather than a ban.
    expect(HealthSummaryKey.parse({ ...dueForRotation, nominal: { atLeast: 1, atMost: 5 } }).nominal).toEqual({
      atLeast: 1,
      atMost: 5,
    });
  });

  test("**a state's nominal members must be members it declares**", () => {
    // Otherwise the claim is unverifiable: a nominal naming `ok` on a key whose states are
    // `ready`/`degraded` can never match a value the producer is allowed to send.
    expect(() => HealthSummaryKey.parse({ ...storeState, nominal: ["ok"] })).toThrow();
    expect(() => HealthSummaryKey.parse({ ...storeState, nominal: [] })).toThrow();
  });
});

/**
 * **Where a value stands against its own declaration, and the third answer that is the whole point.**
 *
 * `unknowable` is not a tidy-up. A key that declares no nominal is a key nobody can grade, and
 * answering `nominal` for it would rebuild #471's defect one layer up — a client reading healthy
 * because nothing told it otherwise. #350 made the four states a discriminated union for the same
 * reason: so a consumer that forgets the sick case gets a type error rather than a screen that lies.
 */
describe("a value stands somewhere, and `unknowable` is never `nominal`", () => {
  /** A count whose good answer is zero — the real `@pithy-sh/secrets` declaration. */
  const overdue = HealthSummaryKey.parse({ ...dueForRotation, nominal: { atMost: 0 } });
  /** A count whose good answer is *not* zero. The pair is the issue's entire premise. */
  const senders = HealthSummaryKey.parse({
    key: "verifiedSenders",
    kind: "count",
    states: null,
    scope: "secrets:status:read",
    cost: "indexed",
    summary: "Sender addresses that have completed domain verification.",
    nominal: { atLeast: 1 },
  });
  const store = HealthSummaryKey.parse({ ...storeState, nominal: ["ready"] });

  test("**a key that claims nothing is unknowable, for a count and for a state alike**", () => {
    // Asserted on its own rather than folded into a broader case, because this is the single answer
    // most likely to be got wrong and the one whose failure is invisible on screen.
    expect(standingOf(HealthSummaryKey.parse(dueForRotation), 0)).toBe("unknowable");
    expect(standingOf(HealthSummaryKey.parse(dueForRotation), 99)).toBe("unknowable");
    expect(standingOf(HealthSummaryKey.parse(storeState), "ready")).toBe("unknowable");
    expect(standingOf(HealthSummaryKey.parse(storeState), "degraded")).toBe("unknowable");
  });

  test("**an `atMost` bound and an `atLeast` bound, because one implemented backwards passes the other**", () => {
    // The plant: with only the `atMost: 0` fixture, a comparison written the wrong way round still
    // answers correctly for 0. The `atLeast` pair is what refuses it.
    expect(standingOf(overdue, 0)).toBe("nominal");
    expect(standingOf(overdue, 3)).toBe("attention");
    expect(standingOf(senders, 0)).toBe("attention");
    expect(standingOf(senders, 1)).toBe("nominal");
  });

  test("a bound is inclusive at its edge, in both directions", () => {
    const between = HealthSummaryKey.parse({ ...dueForRotation, nominal: { atLeast: 1, atMost: 5 } });
    expect([standingOf(between, 1), standingOf(between, 5)]).toEqual(["nominal", "nominal"]);
    expect([standingOf(between, 0), standingOf(between, 6)]).toEqual(["attention", "attention"]);
  });

  test("a state stands by membership of the nominal list, not of the declared one", () => {
    expect(standingOf(store, "ready")).toBe("nominal");
    expect(standingOf(store, "degraded")).toBe("attention");
  });

  test("**a value contradicting its own kind is unknowable, never graded**", () => {
    // A client parses a manifest from a Worker it does not control, and `checked()` runs on the
    // producing side. Grading a string as a count would be inventing an answer about a malformed one.
    expect(standingOf(overdue, "three")).toBe("unknowable");
    expect(standingOf(store, 1)).toBe("unknowable");
  });
});

/**
 * The values worth somebody's attention, over a whole capability.
 *
 * Written here so every client does not rebuild it, and shaped like `namedHealthValues` because it
 * answers the same question one filter later.
 */
describe("what a capability reports that wants attention", () => {
  const overdue = HealthSummaryKey.parse({ ...dueForRotation, nominal: { atMost: 0 } });
  const store = HealthSummaryKey.parse({ ...storeState, nominal: ["ready"] });
  /** Declared, reported, and graded by nothing — it must never reach the list. */
  const ungraded = HealthSummaryKey.parse({ ...dueForRotation, key: "secretsTracked" });
  const keys = [overdue, store, ungraded];

  test("**each of the three stateless reports answers empty, asserted one at a time**", () => {
    // They are states of the *report* rather than of any value. Conflating one with a graded measure
    // is the collapse this whole seam exists to prevent, so none of them is allowed to be a row.
    for (const health of [
      { state: "undeclared" },
      { state: "withheld" },
      { state: "unavailable" },
    ] satisfies CapabilityHealthReport[]) {
      expect(healthAttention({ healthKeys: keys, health })).toEqual([]);
    }
  });

  test("only the values standing at attention, in declaration order", () => {
    const health: CapabilityHealthReport = {
      state: "reported",
      values: { secretsDueForRotation: 3, storeState: "degraded", secretsTracked: 41 },
    };
    expect(healthAttention({ healthKeys: keys, health }).map((named) => named.key.key)).toEqual([
      "secretsDueForRotation",
      "storeState",
    ]);
  });

  test("**a capability with nothing wrong is empty, and an ungraded value is not `nominal` either**", () => {
    // Both exclusions in one case, because they are one rule: the list is what stands at `attention`,
    // and neither a good value nor an ungradeable one does.
    const health: CapabilityHealthReport = {
      state: "reported",
      values: { secretsDueForRotation: 0, storeState: "ready", secretsTracked: 41 },
    };
    expect(healthAttention({ healthKeys: keys, health })).toEqual([]);
  });
});

/**
 * **A key nobody parsed still gets an answer rather than a stack trace — #471 review, F1.**
 *
 * `standingOf` is exported, and this module's doctrine is that a client parses manifests from Workers
 * it does not control. A key built by hand and asserted into the type — a fixture, a fake, a client
 * that trusted a cast — reaches it with `nominal` absent rather than null.
 *
 * It threw, on the `count` branch only: `!Array.isArray(undefined)` happened to catch the same input on
 * the `state` branch and answer `unknowable`. One malformed input, two behaviors, and the crash on the
 * commoner kind. Both answer now, and both are asserted, because a fix on one branch of an asymmetry is
 * how the asymmetry comes back.
 */
describe("a key that never went through a parse still gets an answer", () => {
  const unparsed = {
    key: "k",
    kind: "count",
    states: null,
    scope: "secrets:status:read",
    cost: "indexed",
    summary: "s",
  };

  test("**absent is unknowable, on the count branch and on the state branch alike**", () => {
    expect(standingOf(unparsed as unknown as HealthSummaryKeyOut, 0)).toBe("unknowable");
    const asState = { ...unparsed, kind: "state", states: ["ready"] };
    expect(standingOf(asState as unknown as HealthSummaryKeyOut, "ready")).toBe("unknowable");
  });
});
