import { describe, expect, it } from "vitest";
import type { RatedOutcome, RatingEntry } from "../algorithm";
import { EloParams, EloState, elo } from "./elo";

const defaults = EloParams.parse({});

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

function entry(playerId: string, rating: number): RatingEntry<EloState> {
  return { playerId, state: { rating } };
}

describe("elo", () => {
  it("declares 1v1-only bounds", () => {
    expect(elo.id).toBe("elo");
    expect(elo.minPlayers).toBe(2);
    expect(elo.maxPlayers).toBe(2);
    expect(elo.supportsTeams).toBe(false);
  });

  it("EloParams.parse({}) yields the standard tuning defaults", () => {
    expect(defaults).toEqual({ k: 32, initialRating: 1500 });
  });

  it("initial() builds a newcomer at the params' initialRating", () => {
    expect(elo.initial(defaults)).toEqual({ rating: 1500 });
    expect(elo.initial(EloParams.parse({ initialRating: 1000 }))).toEqual({ rating: 1000 });
  });

  it("skill() is the rating itself", () => {
    expect(elo.skill(defaults, { rating: 1737 })).toBe(1737);
  });

  it("worked value: two 1500 players, A beats B, K=32 => A=1516, B=1484", () => {
    const entries = [entry("A", 1500), entry("B", 1500)];
    const outcome: RatedOutcome = { ranks: { A: 1, B: 2 } };
    const next = elo.update(defaults, entries, outcome);
    expect(need(next.A).rating).toBe(1516);
    expect(need(next.B).rating).toBe(1484);
  });

  it("a decisive win moves the winner up and the loser down (mirror-symmetric)", () => {
    const entries = [entry("A", 1600), entry("B", 1400)];
    const win: RatedOutcome = { ranks: { A: 1, B: 2 } };
    const next = elo.update(defaults, entries, win);
    expect(need(next.A).rating).toBeGreaterThan(1600);
    expect(need(next.B).rating).toBeLessThan(1400);
    // Symmetric: winner's gain equals loser's loss.
    expect(need(next.A).rating - 1600).toBeCloseTo(1400 - need(next.B).rating, 12);
  });

  it("a draw between equals is a no-op", () => {
    const entries = [entry("A", 1500), entry("B", 1500)];
    const draw: RatedOutcome = { ranks: { A: 1, B: 1 } };
    const next = elo.update(defaults, entries, draw);
    expect(need(next.A).rating).toBe(1500);
    expect(need(next.B).rating).toBe(1500);
  });

  it("keeps unrounded floats", () => {
    const entries = [entry("A", 1500), entry("B", 1900)];
    const outcome: RatedOutcome = { ranks: { A: 1, B: 2 } };
    const next = elo.update(defaults, entries, outcome);
    // Underdog A (1500) beats favorite B (1900): expectedA ≈ 0.0909, gain ≈ 29.09.
    expect(need(next.A).rating).toBeCloseTo(1529.0909, 3);
    expect(Number.isInteger(need(next.A).rating)).toBe(false);
  });

  it("state round-trips through the EloState schema", () => {
    const value: EloState = { rating: 1523.5 };
    expect(EloState.parse(value)).toEqual(value);
  });

  it("throws for a non-1v1 roster", () => {
    const three = [entry("A", 1500), entry("B", 1500), entry("C", 1500)];
    const outcome: RatedOutcome = { ranks: { A: 1, B: 2, C: 3 } };
    expect(() => elo.update(defaults, three, outcome)).toThrow();
  });
});
