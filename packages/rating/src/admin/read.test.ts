// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import "../algorithm/builtins";
import { RatingConfig, validateRatingGames } from "../config/config";
import { listPools } from "./read";

describe("listPools", () => {
  test("one entry per pool, in the order each first appears, with every game that rates it", () => {
    const games = validateRatingGames(
      RatingConfig.parse({
        games: [
          { key: "duel", algorithm: "elo" },
          { key: "brawl", algorithm: "trueskill", players: 4, pool: "global" },
          { key: "ranked", algorithm: "elo", pool: "duel" },
          { key: "squad", algorithm: "trueskill", players: 4, pool: "global" },
        ],
      }),
    );
    expect(listPools(games)).toEqual([
      { pool: "duel", algorithm: "elo", games: ["duel", "ranked"] },
      { pool: "global", algorithm: "trueskill", games: ["brawl", "squad"] },
    ]);
  });
});
