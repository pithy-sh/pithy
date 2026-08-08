// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, it } from "vitest";
import {
  isLeaderboardCapability,
  LEADERBOARD_MIGRATION_ORDER,
  type LeaderboardOptions,
  leaderboard,
  needsRankWorker,
} from "./capability";
import { LeaderboardConfig } from "./config/config";

const boards = [{ key: "b1", direction: "desc" as const }];

describe("leaderboard()", () => {
  it("names itself so the migration namespace and error domain line up", () => {
    expect(leaderboard({ boards }).name).toBe("leaderboard");
  });

  it("requires only the app D1 binding", () => {
    expect(leaderboard({ boards }).requiredBindings).toEqual([{ type: "d1", name: "DB", optional: false }]);
  });

  it("declares no peer capabilities — auth is a seam, not a dependency", () => {
    // Depending on auth would be wrong: the routes read `c.var.auth` through core's AuthContext, so
    // without auth installed they deny rather than open. That is the right failure and needs no edge.
    expect(leaderboard({ boards }).dependsOn ?? []).toEqual([]);
  });

  it("contributes its tables to the app database", () => {
    const tables = leaderboard({ boards }).databases?.app?.tables ?? {};
    expect(Object.keys(tables).sort()).toEqual([
      "pithyLeaderboardBoards",
      "pithyLeaderboardEntries",
      "pithyLeaderboardLocks",
    ]);
  });

  it("ships its migration under a stable local key", () => {
    const spec = leaderboard({ boards }).databases?.app;
    expect(Object.keys(spec?.migrations ?? {})).toEqual(["0001_entries"]);
    expect(spec?.migrationOrder).toBe(LEADERBOARD_MIGRATION_ORDER);
  });

  it("sorts after the capabilities already in the app database", () => {
    // media is 300, audit 250, email 200. A collision would throw at registry assembly.
    expect(LEADERBOARD_MIGRATION_ORDER).toBeGreaterThan(300);
  });

  it("exposes its resolved config, with defaults applied", () => {
    const capability = leaderboard({ boards });
    expect(capability.leaderboardConfig.rank).toBe("live");
    expect(capability.leaderboardConfig.boards[0]?.aggregation).toBe("best");
  });

  it("registers routes", () => {
    expect(typeof leaderboard({ boards }).routes).toBe("function");
  });

  it("carries its config schema, so the CLI can document it", () => {
    expect(leaderboard({ boards }).config).toBe(LeaderboardConfig);
  });

  it("fails at assembly on an invalid board rather than on the first submission", () => {
    expect(() => leaderboard({ boards: [{ key: "b1", direction: "desc", window: "nonsense" }] })).toThrow();
  });

  it("fails at assembly with no boards", () => {
    expect(() => leaderboard({ boards: [] })).toThrow();
  });
});

describe("isLeaderboardCapability", () => {
  it("recognizes the capability", () => {
    expect(isLeaderboardCapability(leaderboard({ boards }))).toBe(true);
  });

  it("rejects another capability", () => {
    expect(isLeaderboardCapability({ name: "media", requiredBindings: [] })).toBe(false);
  });
});

describe("needsRankWorker", () => {
  const parse = (input: Parameters<typeof LeaderboardConfig.parse>[0]) => LeaderboardConfig.parse(input);

  it("is false for an all-time board on live rank — the case that needs no moving parts at all", () => {
    expect(needsRankWorker(parse({ boards }))).toBe(false);
  });

  it("is false for a windowed board that keeps everything — there is nothing to prune", () => {
    // Keep-all is the default now, so a bare windowed board needs no worker.
    expect(needsRankWorker(parse({ boards: [{ key: "b1", direction: "desc", window: "0 0 * * *" }] }))).toBe(false);
  });

  it("is true when a board configures window-count retention", () => {
    expect(
      needsRankWorker(parse({ boards: [{ key: "b1", direction: "desc", window: "0 0 * * *", retain: 12 }] })),
    ).toBe(true);
  });

  it("is true when a board configures age-based retention", () => {
    expect(
      needsRankWorker(parse({ boards: [{ key: "b1", direction: "desc", window: "0 0 * * *", retainDays: 90 }] })),
    ).toBe(true);
  });

  it("is true when rank is materialized", () => {
    expect(needsRankWorker(parse({ boards, rank: { materialize: "0 * * * *" } }))).toBe(true);
  });
});

/**
 * What `pithy add leaderboard` writes, checked against what `leaderboard()` accepts.
 *
 * Two defects, one of them hiding the other. `serverAuthoritative` was defaulted to the **string**
 * `"true"` against a boolean field, and that error is reported first — so the missing `boards` only
 * appeared once the typo was fixed (#168).
 *
 * `boards: []` would have been the cheap fix for the second, and it is the wrong one: `boards` carries
 * `.min(1)` with a message saying why, so an empty seed compiles and then throws `too_small` on the
 * first config load. Both halves are asserted here: `seeded` is type-annotated, so a shape
 * `leaderboard()` would reject fails the compile, and the factory call proves it survives the refusal.
 */
describe("pithy.manifest.json", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  /** Exactly the object `pithy add` renders: every option's key at its manifest default. */
  const rendered = Object.fromEntries(manifest.configOptions.map((option) => [option.key, option.default]));

  const seeded: LeaderboardOptions = {
    boards: [{ key: "high-scores", direction: "desc" }],
    rank: "live",
    serverAuthoritative: true,
  };

  it("states every option LeaderboardConfig requires, at a value the type accepts", () => {
    expect(rendered).toEqual(seeded);
  });

  it("seeds a board the config will actually load — an empty array would not", () => {
    const capability = leaderboard(seeded);
    expect(capability.leaderboardConfig.boards.map((board) => board.key)).toEqual(["high-scores"]);
    expect(() => leaderboard({ ...seeded, boards: [] })).toThrow();
  });

  it("seeds the one board shape that needs no rank worker", () => {
    // All-time and live: nothing to prune, nothing to refresh. A seeded board that quietly obliged the
    // adopter to deploy a cron worker would be a worse default than no board at all.
    expect(needsRankWorker(LeaderboardConfig.parse(seeded))).toBe(false);
  });
});
