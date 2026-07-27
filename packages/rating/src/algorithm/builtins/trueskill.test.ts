import { describe, expect, it } from "vitest";
import type { RatingEntry } from "../algorithm";
import { erf, normCdf, normPdf, normPpf, TrueSkillParams, TrueSkillState, trueskill } from "./trueskill";

const params = TrueSkillParams.parse({});

/** Build a rated entry from a plain state. */
function entry(playerId: string, state: TrueSkillState): RatingEntry<TrueSkillState> {
  return { playerId, state };
}

/** A fresh newcomer at the tuning defaults. */
function newcomer(playerId: string): RatingEntry<TrueSkillState> {
  return entry(playerId, trueskill.initial(params));
}

describe("standard-normal helpers", () => {
  it("erf is odd and pinned at known points", () => {
    expect(erf(0)).toBeCloseTo(0, 6); // A&S 7.1.26 is accurate to ~1.5e-7, not exact at 0
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect(erf(-1)).toBeCloseTo(-0.8427007929, 6);
  });

  it("normCdf matches the textbook values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normCdf(1)).toBeCloseTo(0.8413447, 4);
  });

  it("normPdf is the standard bell", () => {
    expect(normPdf(0)).toBeCloseTo(0.3989422804, 8);
    expect(normPdf(1)).toBeCloseTo(0.2419707245, 6);
  });

  it("normPpf inverts normCdf", () => {
    expect(normPpf(0.975)).toBeCloseTo(1.959964, 3);
    expect(normPpf(0.5)).toBeCloseTo(0, 6);
    expect(normPpf(0.55)).toBeCloseTo(0.125661, 4);
    // Round-trip through the cdf.
    for (const p of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      expect(normCdf(normPpf(p))).toBeCloseTo(p, 5);
    }
  });
});

describe("trueskill algorithm surface", () => {
  it("declares the any-format bounds", () => {
    expect(trueskill.id).toBe("trueskill");
    expect(trueskill.minPlayers).toBe(2);
    expect(trueskill.maxPlayers).toBe(Number.POSITIVE_INFINITY);
    expect(trueskill.supportsTeams).toBe(true);
  });

  it("Params.parse({}) yields the classic defaults", () => {
    expect(params).toEqual({
      mu: 25,
      sigma: 25 / 3,
      beta: 25 / 6,
      tau: 25 / 300,
      drawProbability: 0.1,
    });
  });

  it("initial() builds a newcomer from the (defaulted) params", () => {
    expect(trueskill.initial(params)).toEqual({ mu: 25, sigma: 25 / 3 });
    expect(trueskill.initial(TrueSkillParams.parse({ mu: 1000, sigma: 100 }))).toEqual({
      mu: 1000,
      sigma: 100,
    });
  });

  it("skill() is the conservative μ − 3σ", () => {
    // A default newcomer's conservative skill starts at exactly 0.
    expect(trueskill.skill(params, trueskill.initial(params))).toBeCloseTo(0, 10);
    expect(trueskill.skill(params, { mu: 30, sigma: 5 })).toBe(15);
  });

  it("state round-trips through the State schema", () => {
    const value: TrueSkillState = { mu: 29.396, sigma: 7.171 };
    expect(TrueSkillState.parse(value)).toEqual(value);
  });
});

describe("trueskill update — worked values", () => {
  it("1v1: a decisive win moves winner up, loser down, both σ shrink (pinned)", () => {
    const result = trueskill.update(params, [newcomer("A"), newcomer("B")], {
      ranks: { A: 1, B: 2 },
    });

    const a = result.A;
    const b = result.B;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) throw new Error("unreachable");

    expect(a.mu).toBeCloseTo(29.396, 2); // within 0.05
    expect(b.mu).toBeCloseTo(20.604, 2);
    expect(a.sigma).toBeCloseTo(7.171, 2);
    expect(b.sigma).toBeCloseTo(7.171, 2);
    // Winner up, loser symmetric down.
    expect(a.mu).toBeGreaterThan(25);
    expect(b.mu).toBeLessThan(25);
    expect(a.mu - 25).toBeCloseTo(25 - b.mu, 6);
  });

  it("1v1 draw between equals is ~a no-op on μ but still shrinks σ", () => {
    const result = trueskill.update(params, [newcomer("A"), newcomer("B")], {
      ranks: { A: 1, B: 1 },
    });
    const a = result.A;
    const b = result.B;
    if (!a || !b) throw new Error("unreachable");

    expect(a.mu).toBeCloseTo(25, 1); // within 0.3
    expect(b.mu).toBeCloseTo(25, 1);
    expect(a.sigma).toBeLessThan(25 / 3); // dropped below the 8.333 prior
    expect(b.sigma).toBeLessThan(25 / 3);
    expect(a.sigma).toBeCloseTo(b.sigma, 9);
  });

  it("3-player free-for-all keeps μ order A>B>C and shrinks every σ", () => {
    const result = trueskill.update(params, [newcomer("A"), newcomer("B"), newcomer("C")], {
      ranks: { A: 1, B: 2, C: 3 },
    });
    const a = result.A;
    const b = result.B;
    const c = result.C;
    if (!a || !b || !c) throw new Error("unreachable");

    expect(a.mu).toBeGreaterThan(b.mu);
    expect(b.mu).toBeGreaterThan(c.mu);
    for (const r of [a, b, c]) {
      expect(r.sigma).toBeLessThan(25 / 3);
      expect(r.sigma).toBeGreaterThan(0);
    }
    // The symmetric middle finisher nets out at the prior mean.
    expect(b.mu).toBeCloseTo(25, 6);
  });

  it("2v2: team X beats team Y — both X members rise, both Y members fall", () => {
    const roster = [newcomer("A"), newcomer("B"), newcomer("C"), newcomer("D")];
    const result = trueskill.update(params, roster, {
      ranks: { A: 1, B: 1, C: 2, D: 2 },
      teams: { A: "X", B: "X", C: "Y", D: "Y" },
    });
    const a = result.A;
    const b = result.B;
    const c = result.C;
    const d = result.D;
    if (!a || !b || !c || !d) throw new Error("unreachable");

    for (const winner of [a, b]) expect(winner.mu).toBeGreaterThan(25);
    for (const loser of [c, d]) expect(loser.mu).toBeLessThan(25);
    // Identical teammates move identically; winners and losers are symmetric about the prior.
    expect(a.mu).toBeCloseTo(b.mu, 9);
    expect(c.mu).toBeCloseTo(d.mu, 9);
    expect(a.mu - 25).toBeCloseTo(25 - c.mu, 6);
    for (const r of [a, b, c, d]) expect(r.sigma).toBeLessThan(25 / 3);
  });

  it("returns a state for every entered player", () => {
    const result = trueskill.update(params, [newcomer("A"), newcomer("B"), newcomer("C")], {
      ranks: { A: 1, B: 2, C: 3 },
    });
    expect(Object.keys(result).sort()).toEqual(["A", "B", "C"]);
    for (const state of Object.values(result)) {
      expect(TrueSkillState.parse(state)).toEqual(state);
    }
  });
});
