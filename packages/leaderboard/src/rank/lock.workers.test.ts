// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { leaderboardDatabase } from "../data/tables";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import {
  acquireRefreshLock,
  DEFAULT_LOCK_STALE_MS,
  MAX_LOCK_STALE_MS,
  releaseRefreshLock,
  requireLockStaleMs,
} from "./lock";

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

  test("honors a custom stale horizon", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW, 1000)).toBe(true);
    expect(await acquireRefreshLock(db(), "B", later(500), 1000)).toBe(false);
    expect(await acquireRefreshLock(db(), "B", later(1001), 1000)).toBe(true);
  });
});

/**
 * The payload of the `PithyError` `run` threw, or a failure naming what came back instead.
 *
 * `toThrow(/…/)` reads `error.message`, which on a `PithyError` is the *caller's* half — deliberately
 * bland, and never the place a var name belongs. The var an operator must fix lives in `action`, so
 * that is what these assertions read.
 */
async function refusalOf(run: () => Promise<unknown> | unknown): Promise<PithyError["payload"]> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PithyError) return error.payload;
    throw error;
  }
  throw new Error("expected a PithyError, and nothing was thrown");
}

/**
 * The stale horizon is a number a comparison is built from, so a value that is not one does not widen
 * the comparison — it deletes it (#521). Both directions are pinned against real D1, because both are
 * silent: one steals a live holder's lock on every fire, the other kills the run with a `ZodError`
 * naming a `Date`.
 */
describe("the stale horizon is refused before it is compared", () => {
  test("a negative horizon does not steal a live holder's lock", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    // Unrefused this resolves `true`: `staleBefore` lands in the future, the takeover WHERE is true of
    // every row, and B writes ranks alongside A.
    const payload = await refusalOf(() => acquireRefreshLock(db(), "B", later(1000), -3_600_000));
    expect(payload.action).toContain("LEADERBOARD_LOCK_STALE_MS");
    // And A still holds it — the refusal happened before the upsert, so nothing was written.
    expect(await acquireRefreshLock(db(), "A", later(2000))).toBe(true);
  });

  test("a zero horizon is refused too — every lock is instantly stale", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    expect((await refusalOf(() => acquireRefreshLock(db(), "B", later(1), 0))).action).toContain(
      "LEADERBOARD_LOCK_STALE_MS",
    );
  });

  test("a horizon that is not a number is refused with a payload an operator can act on", async () => {
    const payload = await refusalOf(() => acquireRefreshLock(db(), "A", NOW, Number.NaN));
    expect(payload.code).toBe("core/internal");
    // The var by name, in the field written for an operator. Without it the refusal is a `ZodError`
    // reading "expected date, received Date", which names nothing.
    expect(payload.action).toContain("LEADERBOARD_LOCK_STALE_MS");
    expect(payload.detail).toContain("NaN");
  });

  test("Infinity is refused — the loud spelling of never reclaim", async () => {
    expect((await refusalOf(() => acquireRefreshLock(db(), "A", NOW, Number.POSITIVE_INFINITY))).action).toContain(
      "LEADERBOARD_LOCK_STALE_MS",
    );
  });

  test("a horizon past the ceiling is refused rather than clamped", async () => {
    expect((await refusalOf(() => requireLockStaleMs(MAX_LOCK_STALE_MS + 1))).action).toContain(
      "LEADERBOARD_LOCK_STALE_MS",
    );
    // The default and the ceiling itself are both fine — the check bounds, it does not narrow.
    expect(requireLockStaleMs(MAX_LOCK_STALE_MS)).toBe(MAX_LOCK_STALE_MS);
    expect(requireLockStaleMs(DEFAULT_LOCK_STALE_MS)).toBe(DEFAULT_LOCK_STALE_MS);
    expect(requireLockStaleMs(1)).toBe(1);
  });

  test("a fractional millisecond count is refused", async () => {
    expect((await refusalOf(() => requireLockStaleMs(1500.5))).action).toContain("LEADERBOARD_LOCK_STALE_MS");
  });

  test("the default path still acquires and still reclaims", async () => {
    expect(await acquireRefreshLock(db(), "A", NOW)).toBe(true);
    expect(await acquireRefreshLock(db(), "B", later(DEFAULT_LOCK_STALE_MS - 1))).toBe(false);
    expect(await acquireRefreshLock(db(), "B", later(DEFAULT_LOCK_STALE_MS + 1))).toBe(true);
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
