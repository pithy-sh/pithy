// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  type CapabilityHealthReport,
  HEALTH_SUMMARY_IS_SCALAR_ONLY,
  HealthSummaryKey,
  healthReport,
  healthWire,
  namedHealthValues,
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
