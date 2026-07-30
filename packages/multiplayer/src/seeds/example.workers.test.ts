// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { composeSeeds } from "@pithy-sh/core/src/seed/compose";
import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, it } from "vitest";
import { multiplayer } from "../capability";
import type { MultiplayerResult } from "../data/result";
import { MULTIPLAYER_RESULTS_TABLE } from "../data/tables";
import { multiplayerExampleSeed } from "./example";

const games = [{ key: "demo", kind: "connect-n" as const, rules: { rows: 3, cols: 3, connect: 3 } }];

describe("multiplayerExampleSeed", () => {
  it("is flagged as an example", () => {
    expect(multiplayerExampleSeed.example).toBe(true);
  });

  it("never lists production — an example fixture is dev/staging only", () => {
    expect(multiplayerExampleSeed.environments).not.toContain("production");
    expect(multiplayerExampleSeed.environments).toEqual(["dev", "staging"]);
  });

  it("seeds a single resolved demo match into the app database", () => {
    expect(multiplayerExampleSeed.d1).toHaveLength(1);
    const [group] = multiplayerExampleSeed.d1 ?? [];
    expect(group?.database).toBe("app");
    expect(group?.table).toBe(MULTIPLAYER_RESULTS_TABLE);
    expect(group?.rows).toHaveLength(1);

    const [row] = (group?.rows ?? []) as readonly MultiplayerResult[];
    expect(row?.status).toBe("resolved");
    expect(row?.winnerUserId).toBe(EXAMPLE_ADA.id);
    expect(row?.players).toEqual([EXAMPLE_ADA.id, EXAMPLE_GRACE.id, EXAMPLE_ALAN.id]);
    expect(row?.draw).toBe(false);
  });
});

describe("multiplayer() with seed.includeExamples", () => {
  it("composes the example set only when includeExamples is on", () => {
    const capability = multiplayer({ games });

    const withoutExamples = composeSeeds([capability], { env: "dev", includeExamples: false });
    expect(withoutExamples.sets).toHaveLength(0);

    const withExamples = composeSeeds([capability], { env: "dev", includeExamples: true });
    expect(withExamples.sets).toHaveLength(1);
    expect(withExamples.sets[0]?.key).toContain("multiplayer");
  });

  it("never composes the example set for production, even with includeExamples on", () => {
    const capability = multiplayer({ games });

    const result = composeSeeds([capability], { env: "production", includeExamples: true });
    expect(result.sets).toHaveLength(0);
    expect(result.skippedByEnv.length).toBeGreaterThan(0);
  });
});
