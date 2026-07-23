import { describe, expect, test } from "vitest";
import type { GameContext } from "../model";
import type { RandomSource } from "../random";
import { CrapsConfig, crapsGame } from "./craps";

/** A RandomSource whose `int` returns scripted dice in order. */
function scripted(dice: number[]): RandomSource {
  let i = 0;
  return { next: () => 0, int: () => dice[i++] as number, pick: (items) => items[0] as (typeof items)[number] };
}

const config = CrapsConfig.parse({ currency: "chips", minBet: 5, maxBet: 100 });
const ctx = (players: string[], dice: number[] = []): GameContext<CrapsConfig> => ({
  sessionId: "s",
  config,
  players,
  now: 0,
  random: scripted(dice),
});
type State = ReturnType<typeof crapsGame.init>;
const fresh = (): State => crapsGame.init(ctx([]));
const bet = (state: State, players: string[], player: string, type: string, amount: number): State =>
  crapsGame.apply(ctx(players), state, player, { kind: "bet", bet: { type, amount } }).state;
function roll(state: State, players: string[], shooter: string, dice: [number, number]) {
  const r = crapsGame.apply(ctx(players, dice), state, shooter, { kind: "event" });
  return { state: r.state, effects: r.effects ?? [] };
}

describe("craps — betting rules", () => {
  test("a hold is placed for the stake when a bet lands", () => {
    const res = crapsGame.apply(ctx(["alice"]), fresh(), "alice", { kind: "bet", bet: { type: "pass", amount: 25 } });
    expect(res.effects).toEqual([{ op: "hold", userId: "alice", currency: "chips", amount: 25, ref: "s:bet:0" }]);
  });
  test("bets outside the limits and duplicate pending bets are rejected", () => {
    expect(() => bet(fresh(), ["alice"], "alice", "pass", 1)).toThrow(/between 5 and 100/);
    const s = bet(fresh(), ["alice"], "alice", "pass", 10);
    expect(() => bet(s, ["alice"], "alice", "pass", 10)).toThrow(/already have a pass bet/);
  });
  test("pass/don't-pass may only be placed on the come-out; field anytime", () => {
    const s = roll(fresh(), ["alice"], "alice", [2, 2]).state; // sum 4 → point
    expect(() => bet(s, ["alice"], "alice", "pass", 10)).toThrow(/only allowed on the come-out/);
    expect(bet(s, ["alice"], "alice", "field", 10).bets).toHaveLength(1);
  });
});

describe("craps — resolution", () => {
  test("come-out 7 wins pass, loses don't-pass", () => {
    let s = bet(fresh(), ["alice", "bob"], "alice", "pass", 10);
    s = bet(s, ["alice", "bob"], "bob", "dont-pass", 10);
    const res = roll(s, ["alice", "bob"], "alice", [3, 4]); // sum 7
    expect(res.effects).toContainEqual({ op: "release", ref: "s:bet:0" });
    expect(res.effects).toContainEqual({
      op: "credit",
      userId: "alice",
      currency: "chips",
      amount: 10,
      ref: "s:bet:0:win",
      memo: "craps win",
    });
    expect(res.effects).toContainEqual({ op: "capture", ref: "s:bet:1" });
  });
  test("come-out 12 loses pass, pushes don't-pass (no credit)", () => {
    let s = bet(fresh(), ["alice"], "alice", "pass", 10);
    s = bet(s, ["alice"], "alice", "dont-pass", 10);
    const res = roll(s, ["alice"], "alice", [6, 6]);
    expect(res.effects).toContainEqual({ op: "capture", ref: "s:bet:0" });
    expect(res.effects).toContainEqual({ op: "release", ref: "s:bet:1" });
    expect(res.effects.some((e) => e.op === "credit")).toBe(false);
  });
  test("a point carries the line bet; making it wins; a seven-out loses and passes the dice", () => {
    let s = bet(fresh(), ["alice", "bob"], "alice", "pass", 10);
    const established = roll(s, ["alice", "bob"], "alice", [3, 3]); // sum 6 → point
    expect((established.state.round as { phase: string; point: number }).phase).toBe("point");
    expect(established.effects).toHaveLength(0); // carried
    s = established.state;
    const won = roll(s, ["alice", "bob"], "alice", [2, 4]); // sum 6 = point → pass wins, same shooter
    expect(won.effects).toContainEqual({
      op: "credit",
      userId: "alice",
      currency: "chips",
      amount: 10,
      ref: "s:bet:0:win",
      memo: "craps win",
    });
    expect((won.state.round as { shooterIndex: number }).shooterIndex).toBe(0);

    // Separately: seven-out passes the dice.
    let s2 = bet(fresh(), ["alice", "bob"], "alice", "pass", 10);
    s2 = roll(s2, ["alice", "bob"], "alice", [4, 4]).state; // point 8
    const out = roll(s2, ["alice", "bob"], "alice", [3, 4]); // seven-out
    expect(out.effects).toContainEqual({ op: "capture", ref: "s:bet:0" });
    expect((out.state.round as { shooterIndex: number }).shooterIndex).toBe(1);
  });
  test("field pays double on 2, even on 3, loses on 7", () => {
    expect(roll(bet(fresh(), ["a"], "a", "field", 10), ["a"], "a", [1, 1]).effects).toContainEqual({
      op: "credit",
      userId: "a",
      currency: "chips",
      amount: 20,
      ref: "s:bet:0:win",
      memo: "craps win",
    });
    expect(roll(bet(fresh(), ["a"], "a", "field", 10), ["a"], "a", [1, 2]).effects).toContainEqual({
      op: "credit",
      userId: "a",
      currency: "chips",
      amount: 10,
      ref: "s:bet:0:win",
      memo: "craps win",
    });
    expect(roll(bet(fresh(), ["a"], "a", "field", 10), ["a"], "a", [3, 4]).effects).toContainEqual({
      op: "capture",
      ref: "s:bet:0",
    });
  });
  test("only the shooter may roll; leaving releases pending bets", () => {
    expect(() => roll(fresh(), ["alice", "bob"], "bob", [1, 1])).toThrow(/not your turn to trigger/);
    const s = bet(fresh(), ["alice", "bob"], "alice", "pass", 10);
    const left = crapsGame.onLeave?.(ctx(["bob"]), s, "alice");
    expect(left?.effects).toEqual([{ op: "release", ref: "s:bet:0" }]);
    expect(left?.state.bets).toHaveLength(0);
  });
});
