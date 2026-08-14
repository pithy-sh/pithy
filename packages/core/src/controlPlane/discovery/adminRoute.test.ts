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
   * Absence and `null` land in the same place here, and that is correct rather than sloppy: #317 made
   * `null` mean *no number* — either nothing is declared or the caller may not see it — and a Worker that
   * declares no keys at all is the first of those. What neither ever means is zero, which the next test
   * is here to keep true.
   */
  test("and an absent summary reads as null, never as zero", () => {
    const parsed = ControlPlaneManifest.parse(PRE_317_MANIFEST);
    for (const capability of parsed.capabilities) expect(capability.health).toBeNull();
  });
});

describe("and the three states #317 defined survive this", () => {
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

  test("nothing declared, withheld, and zero are still three different answers", () => {
    const declaredNothing = CapabilityDescriptor.parse({ ...base, healthKeys: [], health: null });
    const withheld = CapabilityDescriptor.parse({ ...base, healthKeys: [DUE_FOR_ROTATION], health: null });
    const zero = CapabilityDescriptor.parse({
      ...base,
      healthKeys: [DUE_FOR_ROTATION],
      health: { secretsDueForRotation: 0 },
    });

    // Withheld is told from nothing-declared by the keys beside it, not by the null.
    expect(declaredNothing.healthKeys).toEqual([]);
    expect(withheld.healthKeys.map((k) => k.key)).toEqual(["secretsDueForRotation"]);
    expect(declaredNothing.health).toBeNull();
    expect(withheld.health).toBeNull();

    // And zero is a number, which is the distinction the nullability exists to protect.
    expect(zero.health).toEqual({ secretsDueForRotation: 0 });
    expect(zero.health).not.toBeNull();
  });

  test("a Worker that sends the fields is unaffected by the defaults", () => {
    const sent = CapabilityDescriptor.parse({
      ...base,
      healthKeys: [DUE_FOR_ROTATION],
      health: { secretsDueForRotation: 3 },
    });
    expect(sent.healthKeys.map((k) => k.key)).toEqual(["secretsDueForRotation"]);
    expect(sent.health).toEqual({ secretsDueForRotation: 3 });
  });
});
