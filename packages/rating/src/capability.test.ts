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
