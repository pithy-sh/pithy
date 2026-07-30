// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { RatingEntry } from "../algorithm";
import { GlickoParams, GlickoState, glicko } from "./glicko";

const params = GlickoParams.parse({});

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

function entry(playerId: string, state: GlickoState): RatingEntry<GlickoState> {
  return { playerId, state };
}

describe("glicko algorithm metadata", () => {
  it("declares 1v1, no teams", () => {
    expect(glicko.id).toBe("glicko");
    expect(glicko.minPlayers).toBe(2);
    expect(glicko.maxPlayers).toBe(2);
    expect(glicko.supportsTeams).toBe(false);
    expect(glicko.params).toBe(GlickoParams);
    expect(glicko.state).toBe(GlickoState);
  });
});

describe("GlickoParams defaults", () => {
  it("parses {} to Glickman's defaults", () => {
    expect(params).toEqual({ tau: 0.5, initialRating: 1500, initialRd: 350, initialVol: 0.06 });
  });
});

describe("initial()", () => {
  it("builds a newcomer from params", () => {
    expect(glicko.initial(params)).toEqual({ rating: 1500, rd: 350, vol: 0.06 });
  });

  it("honours custom params", () => {
    const custom = GlickoParams.parse({ initialRating: 1200, initialRd: 200, initialVol: 0.05 });
    expect(glicko.initial(custom)).toEqual({ rating: 1200, rd: 200, vol: 0.05 });
  });
});

describe("skill()", () => {
  it("is the conservative rating minus two deviations", () => {
    expect(glicko.skill(params, { rating: 1500, rd: 350, vol: 0.06 })).toBe(1500 - 2 * 350);
    expect(glicko.skill(params, { rating: 1600, rd: 50, vol: 0.06 })).toBe(1500);
  });
});

describe("update() — decisive win between equal default players", () => {
  const a = glicko.initial(params);
  const b = glicko.initial(params);
  const out = glicko.update(params, [entry("A", a), entry("B", b)], { ranks: { A: 1, B: 2 } });

  it("returns a state for every player", () => {
    expect(Object.keys(out).sort()).toEqual(["A", "B"]);
  });

  it("moves the winner above and the loser below 1500", () => {
    expect(need(out.A).rating).toBeGreaterThan(1500);
    expect(need(out.B).rating).toBeLessThan(1500);
  });

  it("is symmetric for equal players", () => {
    expect(need(out.A).rating - 1500).toBeCloseTo(1500 - need(out.B).rating, 9);
    expect(need(out.A).rd).toBeCloseTo(need(out.B).rd, 9);
    expect(need(out.A).vol).toBeCloseTo(need(out.B).vol, 12);
  });

  it("shrinks rd below the starting 350 (a game reduces uncertainty)", () => {
    expect(need(out.A).rd).toBeLessThan(350);
    expect(need(out.B).rd).toBeLessThan(350);
  });

  it("keeps volatility near 0.06 (within 0.001)", () => {
    expect(need(out.A).vol).toBeCloseTo(0.06, 3);
    expect(Math.abs(need(out.A).vol - 0.06)).toBeLessThan(0.001);
    expect(Math.abs(need(out.B).vol - 0.06)).toBeLessThan(0.001);
  });
});

describe("update() — draw between equals is a near no-op", () => {
  const a = glicko.initial(params);
  const b = glicko.initial(params);
  const out = glicko.update(params, [entry("A", a), entry("B", b)], { ranks: { A: 1, B: 1 } });

  it("leaves ratings essentially unchanged", () => {
    expect(need(out.A).rating).toBeCloseTo(1500, 6);
    expect(need(out.B).rating).toBeCloseTo(1500, 6);
  });

  it("still shrinks rd (information gained even from a draw)", () => {
    expect(need(out.A).rd).toBeLessThan(350);
    expect(need(out.B).rd).toBeLessThan(350);
  });
});

describe("update() — a lower-rd (more certain) opponent moves less", () => {
  it("the proven player barely moves; the unproven player swings", () => {
    const proven: GlickoState = { rating: 1500, rd: 30, vol: 0.06 };
    const unproven: GlickoState = { rating: 1500, rd: 350, vol: 0.06 };
    // proven (P) beats unproven (U)
    const out = glicko.update(params, [entry("P", proven), entry("U", unproven)], { ranks: { P: 1, U: 2 } });
    const provenDelta = Math.abs(need(out.P).rating - 1500);
    const unprovenDelta = Math.abs(need(out.U).rating - 1500);
    expect(unprovenDelta).toBeGreaterThan(provenDelta);
  });
});

describe("state round-trips through the schema", () => {
  it("parses a computed state back to itself", () => {
    const a = glicko.initial(params);
    const b = glicko.initial(params);
    const out = glicko.update(params, [entry("A", a), entry("B", b)], { ranks: { A: 1, B: 2 } });
    const parsed = GlickoState.parse(out.A);
    expect(parsed).toEqual(out.A);
  });
});
