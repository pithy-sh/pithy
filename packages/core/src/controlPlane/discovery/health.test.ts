// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import type { z } from "zod";
import { defineCapability } from "../../capability/capability";
import { InternalError, PithyError } from "../../error/pithyError";
import {
  type CapabilityHealthSource,
  capabilityHealthSources,
  defineCapabilityHealth,
  readCapabilityHealth,
} from "./health";
import { HealthSummaryKey } from "./healthSummary";

/**
 * The health seam: a bounded, scalar, scope-inheriting summary a capability contributes to its own
 * manifest entry, so a management client can say "3 secrets need rotating" from the read it already
 * made (#317).
 *
 * Every case below is about one of the three things that would turn this into a data API: a value that
 * is not a scalar, a key nobody declared, and a number a caller was never granted.
 *
 * **The vocabulary's own cases live in `healthSummary.test.ts`** — what a key may be called, what a
 * declaration may hold, and how the four states cross the wire. That half moved out of this module in
 * #430 so that a scope declaration importing `AdminRoute` stops reaching `Capability` and D1 with it.
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

/** A source as the seam holds one, with a producer a case supplies. */
function source(keys: readonly unknown[]): CapabilityHealthSource {
  return {
    capability: "secrets",
    keys: keys.map((key) => HealthSummaryKey.parse(key)),
    read: async () => ({}),
  };
}

describe("a declaration states what it may report, and what it costs", () => {
  test("a count carries no states, and a state carries a closed list", () => {
    const health = defineCapabilityHealth({ keys: [dueForRotation, storeState], read: async () => ({}) });
    expect(health.keys.map((key) => key.key)).toEqual(["secretsDueForRotation", "storeState"]);
    expect(health.keys[1]?.states).toEqual(["ready", "degraded"]);
  });

  test("a state with no closed list is refused — a client could not render what it cannot name", () => {
    expect(() => defineCapabilityHealth({ keys: [{ ...storeState, states: null }], read: async () => ({}) })).toThrow();
  });

  test("a count carrying states is refused — a number has no vocabulary", () => {
    expect(() =>
      defineCapabilityHealth({ keys: [{ ...dueForRotation, states: ["a"] }], read: async () => ({}) }),
    ).toThrow();
  });

  test("a cost the vocabulary cannot name is refused, so a table scan cannot be declared", () => {
    // The vocabulary has no member for a scan — the compiler says so first, and the parse says so to a
    // caller that got past the compiler. That is the constraint: a value whose cost cannot be stated as
    // bounded is a value that does not belong on the most frequently fetched read this seam serves.
    const scanning = { ...dueForRotation, cost: "scan" } as unknown as KeyInput;
    expect(() => defineCapabilityHealth({ keys: [scanning], read: async () => ({}) })).toThrow();
  });

  test("a declaration with no keys is refused — an empty vocabulary is not a summary", () => {
    expect(() => defineCapabilityHealth({ keys: [], read: async () => ({}) })).toThrow();
  });

  test("the same key twice is refused", () => {
    expect(() =>
      defineCapabilityHealth({ keys: [dueForRotation, { ...dueForRotation }], read: async () => ({}) }),
    ).toThrow();
  });

  test("a declaration that skipped the factory does not compile", () => {
    // The gate, and it is the compiler rather than a runtime check: the seam is branded, so the only way
    // to build one is through the factory that parses it. Delete the brand and the directive below stops
    // being needed, which `bun run typecheck` reports as an unused `@ts-expect-error` — so this test
    // fails the build the moment the door stops being the only door.
    const sneaky = defineCapability({
      name: "sneaky",
      requiredBindings: [],
      // @ts-expect-error — an inline literal is not a parsed declaration, and nothing may reach a
      // manifest without having been parsed.
      health: { keys: [HealthSummaryKey.parse(dueForRotation)], read: async () => ({}) },
    });
    expect(sneaky.name).toBe("sneaky");
  });
});

describe("a summary inherits a scope the capability already gates a read with", () => {
  test("a key naming a scope no admin route requires is refused at assembly", () => {
    // The gate. `pithy dashboard connect` offers an adopter the scopes it reads off `adminRoutes`, so a
    // health key behind a scope no route requires could never be granted — the number would be withheld
    // for ever, with nothing anybody could do about it.
    const capability = defineCapability({
      name: "secrets",
      requiredBindings: [],
      adminRoutes: [
        { method: "GET", path: "/secrets/admin/status", scope: "secrets:other:read", summary: "Something else." },
      ],
      health: defineCapabilityHealth({ keys: [dueForRotation], read: async () => ({}) }),
    });
    expect(() => capabilityHealthSources([capability])).toThrow(PithyError);
    // The scope is named in `detail` and never in `message` — the throw-site context an operator needs,
    // on the side of the codec that does not reach a caller.
    try {
      capabilityHealthSources([capability]);
      expect.unreachable("assembly accepted a health key behind an ungrantable scope");
    } catch (error) {
      expect((error as PithyError).payload.detail).toContain("secrets:status:read");
    }
  });

  test("a key behind a scope one of its own routes requires is accepted", () => {
    const capability = defineCapability({
      name: "secrets",
      requiredBindings: [],
      adminRoutes: [
        { method: "GET", path: "/secrets/admin/status", scope: "secrets:status:read", summary: "Every secret." },
      ],
      health: defineCapabilityHealth({ keys: [dueForRotation], read: async () => ({}) }),
    });
    expect(capabilityHealthSources([capability]).get("secrets")?.keys).toHaveLength(1);
  });

  test("a capability contributing nothing is absent, which is not the same as contributing zero", () => {
    const quiet = defineCapability({ name: "quiet", requiredBindings: [] });
    expect(capabilityHealthSources([quiet]).size).toBe(0);
  });
});

describe("a withheld number and a zero do not look the same", () => {
  test("a caller granted the scope gets the number, and zero is a number", async () => {
    const summary = await readCapabilityHealth(source([dueForRotation]), ["secrets:status:read"], async () => ({
      secretsDueForRotation: 0,
    }));
    expect(summary).toEqual({ state: "reported", values: { secretsDueForRotation: 0 } });
  });

  test("a caller without the scope gets `withheld`, and the producer is never asked", async () => {
    let asked = false;
    const summary = await readCapabilityHealth(source([dueForRotation]), ["manifest:read"], async () => {
      asked = true;
      return { secretsDueForRotation: 3 };
    });
    expect(summary).toEqual({ state: "withheld" });
    expect(asked).toBe(false);
  });

  test("a caller granted one of two scopes sees that key and not the other", async () => {
    const two = source([dueForRotation, { ...storeState, scope: "secrets:liveness:read" }]);
    const summary = await readCapabilityHealth(two, ["secrets:status:read"], async () => ({
      secretsDueForRotation: 2,
      storeState: "ready",
    }));
    expect(summary).toEqual({ state: "reported", values: { secretsDueForRotation: 2 } });
  });

  test("no source at all is `undeclared`, so a capability that says nothing renders as nothing", async () => {
    expect(await readCapabilityHealth(undefined, ["secrets:status:read"], async () => ({}))).toEqual({
      state: "undeclared",
    });
  });
});

describe("the produced summary is the declaration, and anything else is unavailable", () => {
  const granted = ["secrets:status:read"];

  /**
   * A violated declaration lands on `unavailable` rather than rejecting, and that is the #350 change to
   * #317's behavior, made deliberately: the blast radius of a rejection is every other capability's
   * number, and from a caller's side "the producer threw" and "what it produced was not permitted" are
   * one fact — this capability could not say. The shape of a declaration is still a hard failure, at
   * assembly, before any request; what reaches here is data-dependent.
   */
  const unavailable = { state: "unavailable" } as const;

  test("a key nobody declared is unavailable rather than being reported or quietly dropped", async () => {
    expect(
      await readCapabilityHealth(source([dueForRotation]), granted, async () => ({
        secretsDueForRotation: 1,
        rows: 12,
      })),
    ).toEqual(unavailable);
  });

  test("a declared key the producer omits is unavailable — a declaration is a promise", async () => {
    expect(await readCapabilityHealth(source([dueForRotation]), granted, async () => ({}))).toEqual(unavailable);
  });

  test("a count that is not a whole non-negative number is unavailable", async () => {
    expect(
      await readCapabilityHealth(source([dueForRotation]), granted, async () => ({ secretsDueForRotation: -1 })),
    ).toEqual(unavailable);
    expect(
      await readCapabilityHealth(source([dueForRotation]), granted, async () => ({ secretsDueForRotation: 1.5 })),
    ).toEqual(unavailable);
    expect(
      await readCapabilityHealth(source([dueForRotation]), granted, async () => ({ secretsDueForRotation: "many" })),
    ).toEqual(unavailable);
  });

  test("a state outside its closed list is unavailable", async () => {
    const one = source([storeState]);
    expect(await readCapabilityHealth(one, granted, async () => ({ storeState: "on fire" }))).toEqual(unavailable);
    expect(await readCapabilityHealth(one, granted, async () => ({ storeState: "degraded" }))).toEqual({
      state: "reported",
      values: { storeState: "degraded" },
    });
  });

  test("a withheld key is still checked, so a producer cannot hide a violation behind a grant", async () => {
    const two = source([dueForRotation, { ...storeState, scope: "secrets:liveness:read" }]);
    expect(
      await readCapabilityHealth(two, granted, async () => ({ secretsDueForRotation: 1, storeState: "on fire" })),
    ).toEqual(unavailable);
  });
});

describe("a producer that throws is its own state, and it rides on the value (#350)", () => {
  const granted = ["secrets:status:read"];

  /** What a producer inside a customer's data path would throw: client-safe text, context in `detail`. */
  function sick(): never {
    throw new InternalError({
      message: "The secret store did not answer.",
      action: "Try again once the store is reachable.",
      detail:
        "D1 SELECT id, name FROM secrets WHERE project = 'acme' failed for connection 4f21 — token sk_live_hunter2",
    });
  }

  test("the state is not equal to withheld and not equal to zero", async () => {
    const one = source([dueForRotation]);
    const failed = await readCapabilityHealth(one, granted, async () => sick());
    const withheld = await readCapabilityHealth(one, ["manifest:read"], async () => ({ secretsDueForRotation: 3 }));
    const zero = await readCapabilityHealth(one, granted, async () => ({ secretsDueForRotation: 0 }));
    const undeclared = await readCapabilityHealth(undefined, granted, async () => ({}));

    // Asserted on the values, not on a rendering: three states that each look different in one
    // rendering can still be the same value, and it is the value every consumer branches on. The
    // inequalities come first so it is the collapse that is caught, rather than the name of the state.
    expect(failed).not.toEqual(zero);
    expect(failed).not.toEqual(withheld);
    expect(failed).not.toEqual(undeclared);
    expect(failed).toEqual({ state: "unavailable" });
    // And the four are four, rather than three plus an alias.
    expect(new Set([failed.state, withheld.state, zero.state, undeclared.state]).size).toBe(4);
  });

  test("a producer that throws synchronously is caught too", async () => {
    // `read` need not be an async function. If it throws before returning a promise, a `try` around the
    // `await` alone would not have caught it.
    expect(await readCapabilityHealth(source([dueForRotation]), granted, () => sick())).toEqual({
      state: "unavailable",
    });
  });

  test("nothing the producer threw survives — the state carries no message, no code, no detail", async () => {
    const failed = await readCapabilityHealth(source([dueForRotation]), granted, async () => sick());
    // The whole value, byte for byte. A field added to `unavailable` later that carried an error's text
    // would fail here, which is the point: the boundary is that there is nowhere to put it.
    expect(Object.keys(failed)).toEqual(["state"]);
    expect(JSON.stringify(failed)).toBe('{"state":"unavailable"}');
    expect(JSON.stringify(failed)).not.toContain("sk_live_hunter2");
  });

  test("nothing is logged, so no console carries the detail the producer threw", async () => {
    const written: unknown[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(...args);
      }),
    );
    try {
      expect(await readCapabilityHealth(source([dueForRotation]), granted, async () => sick())).toEqual({
        state: "unavailable",
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written).toEqual([]);
  });
});
