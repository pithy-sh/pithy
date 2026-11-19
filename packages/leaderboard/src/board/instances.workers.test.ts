// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { LeaderboardConfig, resolveBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { instancePage, listInstances } from "./instances";
import { assertBoardDefinition } from "./registry";

const T0 = new Date(1_700_000_000_000);

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: LEADERBOARD_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => leaderboardDatabase(env.DB);

const config = LeaderboardConfig.parse({
  boards: [{ key: "level-total", direction: "desc" }],
  families: [
    { pattern: "level/:levelId", direction: "asc" },
    { pattern: "levels-extra/:id", direction: "desc" },
  ],
});

/** Record a board the way its first accepted submission does. */
async function record(key: string): Promise<void> {
  const board = resolveBoard(config, key);
  if (!board) throw new Error(`expected ${key} to resolve`);
  await assertBoardDefinition(db(), board, T0);
}

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_stale_windows",
    "pithy_leaderboard_moderations",
    "pithy_leaderboard_contributions",
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

describe("listInstances", () => {
  test("lists only the family's own instances, by key — not a board or a family sharing the prefix's letters", async () => {
    for (const key of ["level/c", "level/a", "level-total", "levels-extra/a", "level/b"]) await record(key);
    const page = await listInstances(db(), "level");
    expect(page.items.map((i) => i.boardKey)).toEqual(["level/a", "level/b", "level/c"]);
    expect(page.nextCursor).toBeNull();
  });

  test("pages by keyset, every instance exactly once", async () => {
    for (const key of ["level/a", "level/b", "level/c", "level/d", "level/e"]) await record(key);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listInstances(db(), "level", { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.items.map((item) => item.boardKey));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["level/a", "level/b", "level/c", "level/d", "level/e"]);
  });

  test("answers an empty page for a family with no instances yet", async () => {
    expect(await listInstances(db(), "level")).toEqual({ items: [], nextCursor: null });
  });

  test("reads a cursor that is not one of ours as a first page", async () => {
    await record("level/a");
    expect((await listInstances(db(), "level", { cursor: "garbage" })).items).toHaveLength(1);
  });
});

describe("instancePage", () => {
  test("resolves every recorded instance of every family to its board, and leaves configured boards out", async () => {
    for (const key of ["level/a", "level-total", "levels-extra/x"]) await record(key);
    const page = await instancePage(db(), config, null);
    expect(page.boards.map((b) => [b.key, b.direction])).toEqual([
      ["level/a", "asc"],
      ["levels-extra/x", "desc"],
    ]);
    expect(page.next).toBeNull();
  });

  test("never holds more than its limit, and walks every instance across families exactly once", async () => {
    const keys = ["level/a", "level/b", "level/c", "levels-extra/x", "levels-extra/y"];
    for (const key of [...keys, "level-total"]) await record(key);
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await instancePage(db(), config, after, 2);
      expect(page.boards.length).toBeLessThanOrEqual(2);
      seen.push(...page.boards.map((b) => b.key));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual(keys);
  });

  test("ends on a full last page with no further page to read", async () => {
    for (const key of ["level/a", "level/b"]) await record(key);
    expect(await instancePage(db(), config, null, 2)).toEqual({
      boards: [expect.objectContaining({ key: "level/a" }), expect.objectContaining({ key: "level/b" })],
      next: null,
    });
  });

  test("skips a recorded instance whose family is no longer configured", async () => {
    await record("level/a");
    const without = LeaderboardConfig.parse({ boards: [{ key: "level-total", direction: "desc" }] });
    expect(await instancePage(db(), without, null)).toEqual({ boards: [], next: null });
  });
});
