// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { composeSeeds } from "@pithy-sh/core/src/seed/compose";
import { describe, expect, it } from "vitest";
import { leaderboard } from "../capability";
import { leaderboardExampleSeed } from "./example";

const boards = [{ key: "demo", direction: "desc" as const }];

describe("leaderboardExampleSeed", () => {
  it("is flagged as an example", () => {
    expect(leaderboardExampleSeed.example).toBe(true);
  });

  it("never lists production — an example fixture is dev/staging only", () => {
    expect(leaderboardExampleSeed.environments).not.toContain("production");
    expect(leaderboardExampleSeed.environments).toEqual(["dev", "staging"]);
  });

  it("seeds a tiny demo board's entries into the app database", () => {
    expect(leaderboardExampleSeed.d1).toHaveLength(1);
    const [group] = leaderboardExampleSeed.d1 ?? [];
    expect(group?.database).toBe("app");
    expect(group?.table).toBe("pithyLeaderboardEntries");
    expect(group?.rows.length).toBeGreaterThan(0);
  });
});

describe("leaderboard() with seed.includeExamples", () => {
  it("composes the example set only when includeExamples is on", () => {
    const capability = leaderboard({ boards });

    const withoutExamples = composeSeeds([capability], { env: "dev", includeExamples: false });
    expect(withoutExamples.sets).toHaveLength(0);

    const withExamples = composeSeeds([capability], { env: "dev", includeExamples: true });
    expect(withExamples.sets).toHaveLength(1);
    expect(withExamples.sets[0]?.key).toContain("leaderboard");
  });

  it("never composes the example set for production, even with includeExamples on", () => {
    const capability = leaderboard({ boards });

    const result = composeSeeds([capability], { env: "production", includeExamples: true });
    expect(result.sets).toHaveLength(0);
    expect(result.skippedByEnv.length).toBeGreaterThan(0);
  });
});
