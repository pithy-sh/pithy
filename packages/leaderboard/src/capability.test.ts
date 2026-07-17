import { describe, expect, it } from "vitest";
import { isLeaderboardCapability, LEADERBOARD_MIGRATION_ORDER, leaderboard, needsRankWorker } from "./capability";
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
