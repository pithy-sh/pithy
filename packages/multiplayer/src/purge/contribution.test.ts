// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { MultiplayerResult } from "../data/result";
import { anonymizedResult } from "./contribution";

/** The one rewrite the multiplayer purge makes (#814): the person's id, everywhere in one result, and nothing else. */

const RESULT: MultiplayerResult = {
  id: 1,
  sessionId: "s1",
  gameKey: "chess",
  status: "resolved",
  players: ["ada", "bob"],
  scores: { ada: 3, bob: 1 },
  winnerUserId: "ada",
  draw: false,
  createdAt: new Date(0),
  resolvedAt: new Date(1),
};

describe("anonymizedResult", () => {
  test("replaces the person in the players, the scores and the winner, and keeps everyone else", () => {
    expect(anonymizedResult(RESULT, "ada", "erased-x")).toEqual({
      ...RESULT,
      players: ["erased-x", "bob"],
      scores: { "erased-x": 3, bob: 1 },
      winnerUserId: "erased-x",
    });
  });

  test("a winner who is someone else stays, and an abandoned session's null scores stay null", () => {
    const abandoned = { ...RESULT, status: "abandoned" as const, scores: null, winnerUserId: null };
    expect(anonymizedResult(abandoned, "ada", "erased-x")).toEqual({ ...abandoned, players: ["erased-x", "bob"] });
    expect(anonymizedResult(RESULT, "bob", "erased-y").winnerUserId).toBe("ada");
  });
});
