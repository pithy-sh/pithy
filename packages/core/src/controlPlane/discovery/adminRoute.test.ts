// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { CapabilityDescriptor, ControlPlaneManifest } from "./adminRoute";

/**
 * A manifest as a Worker deployed before #317 sends it: no `healthKeys`, no `health`, anywhere.
 *
 * Kept as a literal rather than built by stripping fields off a current one. A fixture derived from the
 * schema under test moves whenever the schema moves, which is the one thing a compatibility fixture must
 * not do — it would keep passing by describing whatever the code now expects. This is a transcript.
 */
const PRE_317_MANIFEST = {
  environment: "production",
  connectionId: "conn_01hv8wptq8987qeep44cyrewp9",
  version: "0f689e0a-1c2b-4d3e-8f90-abcdef012345",
  capabilities: [
    { name: "auth", version: "0.4.1", adminRoutes: [] },
    {
      name: "payments",
      version: "0.4.1",
      adminRoutes: [
        { method: "GET", path: "/payments/admin/purchases", scope: "payments:purchases:read", summary: "List them." },
      ],
    },
    { name: "app", version: null, adminRoutes: [] },
  ],
  grantedScopes: ["payments:purchases:read"],
};

describe("a manifest from a Worker that predates the health fields", () => {
  /**
   * The compatibility mechanism, because there is no other one.
   *
   * `ControlPlaneManifest` says in as many words that there is deliberately no manifest schema version —
   * a client dispatches on what the Worker declares right now. With nothing to negotiate on, tolerating
   * absence *is* how a new field ships. A required one is a breaking change with nothing to announce it,
   * and it breaks at the object level: the client loses the whole manifest, not the part it did not know
   * about. Every pane goes dark for a customer whose only mistake was not upgrading yet.
   */
  test("**parses whole, rather than failing the read for every other field on it**", () => {
    const parsed = ControlPlaneManifest.parse(PRE_317_MANIFEST);

    expect(parsed.environment).toBe("production");
    expect(parsed.capabilities.map((c) => c.name)).toEqual(["auth", "payments", "app"]);
    // The point of the whole exercise: the admin surface is still readable from a Worker that says
    // nothing about health, so the panes that dispatch on it still have something to dispatch on.
    expect(parsed.capabilities[1]?.adminRoutes).toHaveLength(1);
    expect(parsed.grantedScopes).toEqual(["payments:purchases:read"]);
  });

  test("and an absent declaration reads as no keys, which is what it means", () => {
    const parsed = ControlPlaneManifest.parse(PRE_317_MANIFEST);
    for (const capability of parsed.capabilities) expect(capability.healthKeys).toEqual([]);
  });

  /**
   * A Worker saying nothing about health declares nothing, which is the first of the four states and
   * the one absence has always meant. What it never means is zero, which the tests below keep true.
   */
  test("and an absent summary reads as `undeclared`, never as zero", () => {
    const parsed = ControlPlaneManifest.parse(PRE_317_MANIFEST);
    for (const capability of parsed.capabilities) expect(capability.health).toEqual({ state: "undeclared" });
  });
});

describe("and the four states survive this", () => {
  const base = { name: "secrets", version: "0.4.1", adminRoutes: [] };

  /** One declared key, spelled out — a `count`, so `states` is null, which the schema refines for. */
  const DUE_FOR_ROTATION = {
    key: "secretsDueForRotation",
    kind: "count",
    states: null,
    scope: "secrets:status:read",
    cost: "indexed",
    summary: "Secrets past their rotation window.",
  };

  test("nothing declared, withheld, zero and unavailable are four different answers", () => {
    const declaredNothing = CapabilityDescriptor.parse({ ...base, healthKeys: [], health: null });
    const withheld = CapabilityDescriptor.parse({ ...base, healthKeys: [DUE_FOR_ROTATION], health: null });
    const zero = CapabilityDescriptor.parse({
      ...base,
      healthKeys: [DUE_FOR_ROTATION],
      health: { secretsDueForRotation: 0 },
    });
    const unavailable = CapabilityDescriptor.parse({
      ...base,
      healthKeys: [DUE_FOR_ROTATION],
      health: null,
      healthUnavailable: true,
    });

    // Withheld is told from nothing-declared by the keys beside it, and both say so on the value now.
    expect(declaredNothing.healthKeys).toEqual([]);
    expect(withheld.healthKeys.map((k) => k.key)).toEqual(["secretsDueForRotation"]);
    expect(declaredNothing.health).toEqual({ state: "undeclared" });
    expect(withheld.health).toEqual({ state: "withheld" });

    // Zero is a number, which is the distinction the whole design exists to protect.
    expect(zero.health).toEqual({ state: "reported", values: { secretsDueForRotation: 0 } });

    // And a producer that failed is its own answer — asserted against the other three as values (#350).
    expect(unavailable.health).toEqual({ state: "unavailable" });
    expect(unavailable.health).not.toEqual(withheld.health);
    expect(unavailable.health).not.toEqual(zero.health);
    expect(unavailable.health).not.toEqual(declaredNothing.health);
  });

  test("a Worker deployed before #350 sends no failure flag, and lands where it always did", () => {
    // Same mechanism as #317's own fields, and the reason the flag sits beside `health` rather than
    // inside it: absence is the only thing a client of an older build can be relied on to send.
    const sent = CapabilityDescriptor.parse({
      ...base,
      healthKeys: [DUE_FOR_ROTATION],
      health: { secretsDueForRotation: 3 },
    });
    expect(sent.healthKeys.map((k) => k.key)).toEqual(["secretsDueForRotation"]);
    expect(sent.health).toEqual({ state: "reported", values: { secretsDueForRotation: 3 } });
  });

  test("each state goes back on the wire as the entry it came from", () => {
    const entries = [
      { ...base, healthKeys: [], health: null, healthUnavailable: false },
      { ...base, healthKeys: [DUE_FOR_ROTATION], health: null, healthUnavailable: false },
      { ...base, healthKeys: [DUE_FOR_ROTATION], health: { secretsDueForRotation: 0 }, healthUnavailable: false },
      { ...base, healthKeys: [DUE_FOR_ROTATION], health: null, healthUnavailable: true },
    ];
    for (const entry of entries) {
      expect(CapabilityDescriptor.encode(CapabilityDescriptor.parse(entry))).toEqual(entry);
    }
  });
});
