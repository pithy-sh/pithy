// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { rating } from "./capability";

const games = [{ key: "ranked", algorithm: "elo" as const }];

describe("rating() scope gates (#560)", () => {
  it("declares the outcome route it gates on the record scope", () => {
    expect(rating({ games }).scopeGates).toEqual([
      { scope: "rating:record", route: "POST /rating/games/:game/outcomes" },
    ]);
  });

  it("declares nothing once `serverAuthoritative` is off — the config removed the gate", () => {
    expect(rating({ games, serverAuthoritative: false }).scopeGates).toEqual([]);
  });
});

describe("rating() management surface (#818)", () => {
  it("advertises five admin routes under the mount path, reads and acts on their own scopes", () => {
    expect(rating({ games, basePath: "/skill" }).adminRoutes).toEqual([
      expect.objectContaining({ method: "GET", path: "/skill/admin/pools", scope: "rating:players:read" }),
      expect.objectContaining({
        method: "GET",
        path: "/skill/admin/pools/:pool/players",
        scope: "rating:players:read",
      }),
      expect.objectContaining({
        method: "GET",
        path: "/skill/admin/pools/:pool/players/:userId",
        scope: "rating:players:read",
      }),
      expect.objectContaining({
        method: "POST",
        path: "/skill/admin/pools/:pool/players/:userId/recalculate",
        scope: "rating:players:adjust",
      }),
      expect.objectContaining({
        method: "POST",
        path: "/skill/admin/pools/:pool/players/:userId/reset",
        scope: "rating:players:adjust",
      }),
    ]);
  });

  it("ships the outcome log as a migration of its own, after the released 0001", () => {
    expect(Object.keys(rating({ games }).databases?.app?.migrations ?? {})).toEqual([
      "0001_rating",
      "0002_outcome_log",
    ]);
  });

  it("hands a composed peer the void consumer beside the store matchmaking reads", () => {
    const peer = rating({ games }).ratingPeer;
    expect(typeof peer.voidResult).toBe("function");
    expect(typeof peer.ratingStore).toBe("function");
    expect(typeof peer.ratingDatabase).toBe("function");
  });
});
