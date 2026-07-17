import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { leaderboardDatabase } from "../data/tables";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { acquireRefreshLock, DEFAULT_LOCK_STALE_MS, releaseRefreshLock } from "./lock";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

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
  for (const t of ["pithy_leaderboard_locks", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await env.DB.exec("DROP TABLE IF EXISTS pithy_leaderboard_entries");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_leaderboard_boards");
  await runMigrations(env.DB, provider());
});

describe("acquireRefreshLock", () => {
  test("acquires a free lock", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
  });

  test("refuses a second holder while the lock is fresh — the whole point", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    expect(await acquireRefreshLock(db(), "B", later(1000))).toBe(false);
  });

  test("the same holder re-acquiring is idempotent, not a conflict", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    // A's lock is fresh, so the takeover WHERE fails; but the row already names A, so A still holds it.
    expect(await acquireRefreshLock(db(), "A", later(1000))).toBe(true);
  });

  test("reclaims a lock older than the stale horizon — a crashed instance does not wedge it forever", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    // Just under the horizon: still A's.
    expect(await acquireRefreshLock(db(), "B", later(DEFAULT_LOCK_STALE_MS - 1))).toBe(false);
    // Past the horizon: B reclaims it.
    expect(await acquireRefreshLock(db(), "B", later(DEFAULT_LOCK_STALE_MS + 1))).toBe(true);
  });

  test("honours a custom stale horizon", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW, 1000)).toBe(true);
    expect(await acquireRefreshLock(db(), "B", later(500), 1000)).toBe(false);
    expect(await acquireRefreshLock(db(), "B", later(1001), 1000)).toBe(true);
  });
});

describe("releaseRefreshLock", () => {
  test("releasing lets the next instance acquire immediately", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    await releaseRefreshLock(db(), "A");
    expect(await acquireRefreshLock(db(), "B", later(1000))).toBe(true);
  });

  test("a non-holder cannot release the lock", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    await releaseRefreshLock(db(), "B"); // B does not hold it
    // A still holds it, so B still cannot acquire.
    expect(await acquireRefreshLock(db(), "B", later(1000))).toBe(false);
  });

  test("releasing an unheld lock is a harmless no-op", async () => {
    await releaseRefreshLock(db(), "ghost");
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
  });
});
