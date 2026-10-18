// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { scopeGateHealth } from "./scopeGates";

/** A capability as the composition hands it over — only the two fields this reads matter. */
function cap(name: string, extra: Partial<Capability> = {}): Capability {
  return { name, requiredBindings: [], ...extra };
}

const LEADERBOARD = cap("leaderboard", {
  scopeGates: [
    { scope: "leaderboard:admin", route: "PUT /leaderboard/:board/entries/:userId/hidden" },
    { scope: "leaderboard:submit", route: "POST /leaderboard/:board" },
  ],
});
const LEDGER = cap("ledger", { scopeGates: [{ scope: "ledger:admin", route: "POST /ledger/:currency/credit" }] });

describe("scopeGateHealth", () => {
  test("names every gate that will deny when nothing composed fills the scopes", () => {
    expect(scopeGateHealth([cap("auth", { providesScopes: false }), LEADERBOARD, LEDGER])).toEqual({
      resolver: null,
      gates: [
        {
          capability: "leaderboard",
          scope: "leaderboard:admin",
          route: "PUT /leaderboard/:board/entries/:userId/hidden",
        },
        { capability: "leaderboard", scope: "leaderboard:submit", route: "POST /leaderboard/:board" },
        { capability: "ledger", scope: "ledger:admin", route: "POST /ledger/:currency/credit" },
      ],
      denying: true,
    });
  });

  test("names the capability that fills them, and denies nothing, once a resolver is configured", () => {
    const health = scopeGateHealth([cap("auth", { providesScopes: true }), LEADERBOARD]);
    expect(health.resolver).toBe("auth");
    expect(health.gates).toHaveLength(2);
    expect(health.denying).toBe(false);
  });

  test("has nothing to say about a Worker that composes no scope-gated capability", () => {
    expect(scopeGateHealth([cap("auth"), cap("email")])).toEqual({ resolver: null, gates: [], denying: false });
  });

  test("denies without auth composed at all — nothing else fills the seam", () => {
    expect(scopeGateHealth([LEDGER]).denying).toBe(true);
  });
});
