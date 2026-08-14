// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { defineCapability } from "../../capability/capability";
import { PithyError } from "../../error/pithyError";
import {
  type CapabilityHealthSource,
  capabilityHealthSources,
  defineCapabilityHealth,
  HealthSummaryKey,
  namedHealthValues,
  readCapabilityHealth,
} from "./health";

/**
 * The health seam: a bounded, scalar, scope-inheriting summary a capability contributes to its own
 * manifest entry, so a management client can say "3 secrets need rotating" from the read it already
 * made (#317).
 *
 * Every case below is about one of the three things that would turn this into a data API: a value that
 * is not a scalar, a key nobody declared, and a number a caller was never granted.
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
    expect(summary).toEqual({ secretsDueForRotation: 0 });
  });

  test("a caller without the scope gets null, and the producer is never asked", async () => {
    let asked = false;
    const summary = await readCapabilityHealth(source([dueForRotation]), ["manifest:read"], async () => {
      asked = true;
      return { secretsDueForRotation: 3 };
    });
    expect(summary).toBeNull();
    expect(asked).toBe(false);
  });

  test("a caller granted one of two scopes sees that key and not the other", async () => {
    const two = source([dueForRotation, { ...storeState, scope: "secrets:liveness:read" }]);
    const summary = await readCapabilityHealth(two, ["secrets:status:read"], async () => ({
      secretsDueForRotation: 2,
      storeState: "ready",
    }));
    expect(summary).toEqual({ secretsDueForRotation: 2 });
  });

  test("no source at all is null, so a capability that says nothing renders as nothing", async () => {
    expect(await readCapabilityHealth(undefined, ["secrets:status:read"], async () => ({}))).toBeNull();
  });
});

describe("the produced summary is the declaration, and anything else throws", () => {
  const granted = ["secrets:status:read"];

  test("a key nobody declared throws rather than being reported or quietly dropped", async () => {
    await expect(
      readCapabilityHealth(source([dueForRotation]), granted, async () => ({ secretsDueForRotation: 1, rows: 12 })),
    ).rejects.toThrow(PithyError);
  });

  test("a declared key the producer omits throws — a declaration is a promise", async () => {
    await expect(readCapabilityHealth(source([dueForRotation]), granted, async () => ({}))).rejects.toThrow(PithyError);
  });

  test("a count that is not a whole non-negative number throws", async () => {
    await expect(
      readCapabilityHealth(source([dueForRotation]), granted, async () => ({ secretsDueForRotation: -1 })),
    ).rejects.toThrow(PithyError);
    await expect(
      readCapabilityHealth(source([dueForRotation]), granted, async () => ({ secretsDueForRotation: 1.5 })),
    ).rejects.toThrow(PithyError);
    await expect(
      readCapabilityHealth(source([dueForRotation]), granted, async () => ({ secretsDueForRotation: "many" })),
    ).rejects.toThrow(PithyError);
  });

  test("a state outside its closed list throws", async () => {
    const one = source([storeState]);
    await expect(readCapabilityHealth(one, granted, async () => ({ storeState: "on fire" }))).rejects.toThrow(
      PithyError,
    );
    expect(await readCapabilityHealth(one, granted, async () => ({ storeState: "degraded" }))).toEqual({
      storeState: "degraded",
    });
  });

  test("a withheld key is still checked, so a producer cannot hide a violation behind a grant", async () => {
    const two = source([dueForRotation, { ...storeState, scope: "secrets:liveness:read" }]);
    await expect(
      readCapabilityHealth(two, granted, async () => ({ secretsDueForRotation: 1, storeState: "on fire" })),
    ).rejects.toThrow(PithyError);
  });
});

describe("a client renders an unknown key as nothing", () => {
  test("a value with no declaration beside it is dropped rather than guessed at", () => {
    // A newer Worker reporting a key this client has never heard of must render as nothing. It has a
    // declaration, so it renders generically; a value with *no* declaration is not renderable at all.
    const named = namedHealthValues({
      healthKeys: [HealthSummaryKey.parse(dueForRotation)],
      health: { secretsDueForRotation: 3, somethingNewer: 9 },
    });
    expect(named).toEqual([{ key: HealthSummaryKey.parse(dueForRotation), value: 3 }]);
  });

  test("a withheld summary names nothing", () => {
    expect(namedHealthValues({ healthKeys: [HealthSummaryKey.parse(dueForRotation)], health: null })).toEqual([]);
  });
});
