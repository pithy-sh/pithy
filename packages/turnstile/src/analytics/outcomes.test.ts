// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { TurnstileOutcomes } from "../http/responses";
import { summarizeOutcomes } from "./outcomes";

describe("summarizeOutcomes (#731)", () => {
  test("classifies every event type Cloudflare documents", () => {
    const outcomes = summarizeOutcomes(
      new Map([
        ["challenge_issued", 100],
        ["challenge_non_interactive_solved", 70],
        ["challenge_interactive_solved", 20],
        ["challenge_non_interactive_siteverify_solved", 60],
        ["challenge_interactive_siteverify_solved", 15],
        ["challenge_clearance_siteverify_solved", 5],
        ["challenge_siteverify_failed_double_redemption", 3],
        ["challenge_siteverify_failed_invalid_token", 2],
        ["challenge_siteverify_failed_other", 1],
        ["challenge_siteverify_ratelimited", 4],
      ]),
    );
    expect(outcomes.issued).toBe(100);
    expect(outcomes.solved).toBe(90);
    expect(outcomes.unsolved).toBe(10);
    expect(outcomes.solveRate).toBe(0.9);
    expect(outcomes.siteverify).toEqual({ passed: 80, refused: 10 });
    expect(TurnstileOutcomes.parse(outcomes)).toEqual(outcomes);
  });

  test("lists every event type, most first, so one Cloudflare adds later is counted rather than dropped", () => {
    const outcomes = summarizeOutcomes(
      new Map([
        ["challenge_issued", 4],
        ["challenge_something_new", 9],
        ["challenge_interactive_solved", 4],
      ]),
    );
    expect(outcomes.events).toEqual([
      { eventType: "challenge_something_new", count: 9 },
      { eventType: "challenge_interactive_solved", count: 4 },
      { eventType: "challenge_issued", count: 4 },
    ]);
    expect(outcomes.issued).toBe(4);
  });

  test("nothing issued is a rate of null, not zero", () => {
    expect(summarizeOutcomes(new Map())).toEqual({
      issued: 0,
      solved: 0,
      unsolved: 0,
      solveRate: null,
      siteverify: { passed: 0, refused: 0 },
      events: [],
    });
  });

  test("unsolved never goes below zero when sampling counts more solves than issues", () => {
    const outcomes = summarizeOutcomes(
      new Map([
        ["challenge_issued", 10],
        ["challenge_non_interactive_solved", 12],
      ]),
    );
    expect(outcomes.unsolved).toBe(0);
    expect(outcomes.solveRate).toBe(1);
  });
});
