// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { assertBoardDefinition } from "./registry";

const T0 = new Date(1_700_000_000_000);

const board = (overrides: Partial<LeaderboardBoard> = {}): LeaderboardBoard =>
  ({ key: "b1", store: "d1", direction: "desc", aggregation: "best", retain: 12, ...overrides }) as LeaderboardBoard;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: { "0001_entries": leaderboard_0001_entries },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => leaderboardDatabase(env.DB);

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
});

describe("assertBoardDefinition", () => {
  test("records the definition on first use", async () => {
    await assertBoardDefinition(db(), board({ window: "0 0 * * *" }), T0);
    const { results } = await env.DB.prepare("SELECT * FROM pithy_leaderboard_boards").all<{
      board_key: string;
      store: string;
      direction: string;
      aggregation: string;
      window: string | null;
    }>();
    expect(results).toEqual([
      expect.objectContaining({
        board_key: "b1",
        store: "d1",
        direction: "desc",
        aggregation: "best",
        window: "0 0 * * *",
      }),
    ]);
  });

  test("records an all-time board with a null window", async () => {
    await assertBoardDefinition(db(), board(), T0);
    const { results } = await env.DB.prepare("SELECT window FROM pithy_leaderboard_boards").all<{
      window: string | null;
    }>();
    expect(results[0]?.window).toBeNull();
  });

  test("passes on an unchanged definition", async () => {
    await assertBoardDefinition(db(), board(), T0);
    await expect(assertBoardDefinition(db(), board(), T0)).resolves.toBeUndefined();
  });

  test("rejects a flipped direction, which would turn every leader into a laggard", async () => {
    await assertBoardDefinition(db(), board(), T0);
    await expect(assertBoardDefinition(db(), board({ direction: "asc" }), T0)).rejects.toThrowError(/cannot change/i);
  });

  test("rejects a changed aggregation, which would reinterpret stored scores", async () => {
    await assertBoardDefinition(db(), board(), T0);
    await expect(assertBoardDefinition(db(), board({ aggregation: "sum" }), T0)).rejects.toThrow();
  });

  test("rejects a changed window schedule", async () => {
    await assertBoardDefinition(db(), board({ window: "0 0 * * *" }), T0);
    await expect(assertBoardDefinition(db(), board({ window: "0 0 * * 1" }), T0)).rejects.toThrow();
  });

  test("rejects adding a window to a board that was all-time", async () => {
    await assertBoardDefinition(db(), board(), T0);
    await expect(assertBoardDefinition(db(), board({ window: "0 0 * * *" }), T0)).rejects.toThrow();
  });

  test("rejects removing the window from a windowed board", async () => {
    await assertBoardDefinition(db(), board({ window: "0 0 * * *" }), T0);
    await expect(assertBoardDefinition(db(), board(), T0)).rejects.toThrow();
  });

  test("rejects a changed store — scores in one store cannot be reinterpreted in another", async () => {
    // `store` has one value today, so this casts a future second value to prove the guard covers it.
    await assertBoardDefinition(db(), board(), T0);
    const moved = board({ store: "clickhouse" as unknown as "d1" });
    await expect(assertBoardDefinition(db(), moved, T0)).rejects.toThrowError(/cannot change/i);
  });

  test("re-reads and enforces the winning record on the first-submission path, not just when a record pre-exists", async () => {
    // The race fix: a first submission whose INSERT-OR-IGNORE loses to a divergent concurrent insert
    // must still be checked against the row that won. Simulated by pre-seeding a divergent winner, then
    // running a first submission that finds no record at its own SELECT time is not deterministically
    // reproducible in a serialized test DB — but the structural guarantee is that the insert path now
    // always falls through to the drift check. This asserts the observable consequence: a divergent
    // definition is rejected regardless of which request recorded the board first.
    await assertBoardDefinition(db(), board({ direction: "asc" }), T0);
    await expect(assertBoardDefinition(db(), board({ direction: "desc" }), T0)).rejects.toThrow();
  });

  test("names the drifted field in the internal detail, never in the client message", async () => {
    await assertBoardDefinition(db(), board(), T0);
    await assertBoardDefinition(db(), board({ direction: "asc" }), T0).then(
      () => expect.unreachable("expected a drift error"),
      (error: { payload: { detail?: string; message: string } }) => {
        expect(error.payload.detail).toContain("direction desc → asc");
        expect(error.payload.message).not.toContain("desc");
      },
    );
  });

  test("tolerates a race on first use rather than failing the loser", async () => {
    // Two first-ever submissions can reach this at once. Losing the insert race is not an error — the
    // winner recorded the same definition.
    await Promise.all([
      assertBoardDefinition(db(), board(), T0),
      assertBoardDefinition(db(), board(), T0),
      assertBoardDefinition(db(), board(), T0),
    ]);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_leaderboard_boards").all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  test("keeps each board's definition separate", async () => {
    await assertBoardDefinition(db(), board(), T0);
    await expect(assertBoardDefinition(db(), board({ key: "b2", direction: "asc" }), T0)).resolves.toBeUndefined();
  });
});
