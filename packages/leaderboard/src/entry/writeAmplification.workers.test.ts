import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKLOAD } from "../../scripts/costModel";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { submitQuery } from "./store";

/**
 * What a submission actually costs, in rows written.
 *
 * `scripts/costModel.ts` assumes `rowsWrittenPerSubmissionPerWindow`, and that one number multiplies
 * through every write figure in docs/costs.md — including the headline $940 at 1M players. The
 * arithmetic tests in `costModel.test.ts` pin the maths but cannot check the *assumption*: they would
 * happily pin a confident, wrong number.
 *
 * So this measures it, against real D1, using the real compiled upsert, and reads D1's own
 * `meta.rows_written`. If the schema grows an index, this fails and the docs get corrected — which is
 * the only way a cost model stays honest as the code moves under it.
 *
 * Caveat worth keeping in view: this runs on Miniflare's D1. Index maintenance is a SQLite-level
 * behaviour so it should carry to production, but `rows_written` accounting is Cloudflare's and could
 * differ. This is evidence, not a Cloudflare guarantee — docs/costs.md says so.
 */

const T0 = new Date(1_700_000_000_000);
const board = (overrides: Partial<LeaderboardBoard> = {}): LeaderboardBoard =>
  ({
    key: "b1",
    store: "d1",
    direction: "desc",
    aggregation: "best",
    retain: 12,
    trackActivity: false,
    ...overrides,
  }) as LeaderboardBoard;

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

/** Run the real submit statement through raw D1 so `meta.rows_written` is visible. */
async function submitAndCount(b: LeaderboardBoard, userId: string, score: number, at: Date): Promise<number> {
  const compiled = submitQuery(leaderboardDatabase(env.DB), b, "all", userId, score, at, true).compile();
  const result = await env.DB.prepare(compiled.sql)
    .bind(...compiled.parameters)
    .run();
  return result.meta.rows_written;
}

async function indexCount(): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='pithy_leaderboard_entries' AND name NOT LIKE 'sqlite_%'",
  ).all<{ n: number }>();
  return results[0]?.n ?? 0;
}

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

describe("rows written per submission", () => {
  test("the entries table carries the two indexes the cost model has to account for", async () => {
    // The unique player index (upsert conflict target) and the rank index (ordering). Both are
    // maintained on every insert, so both are on the submission's write bill.
    expect(await indexCount()).toBe(2);
  });

  test("a steady-state improving submission writes exactly the cost model's assumed rows", async () => {
    // Steady state is an update, not a first insert: it rewrites the row and the rank index (the unique
    // player index does not change), so 2 — the number the cost model prices.
    await submitAndCount(board(), "u1", 10, T0);
    const improving = await submitAndCount(board(), "u1", 50, new Date(T0.getTime() + 1000));
    expect(improving).toBe(DEFAULT_WORKLOAD.rowsWrittenPerSubmissionPerWindow);
  });

  test("the guarded default makes a non-improving submission cost zero rows", async () => {
    // This is the cost lever. On the default `best` board (trackActivity: false) a submission that does
    // not beat the stored score is skipped by the conflict `WHERE` — nothing is written, nothing billed.
    // Truly zero only because the id is a plain rowid: an autoincrement id would still bill a sequence
    // write here, since SQLite reserves the sequence value before it detects the conflict.
    await submitAndCount(board(), "u1", 50, T0);
    const noop = await submitAndCount(board(), "u1", 1, new Date(T0.getTime() + 1000));
    expect(noop).toBe(0);
  });

  test("trackActivity: true writes on a non-improving submission, at full cost", async () => {
    // The opt-in: submittedAt stays a true last-seen timestamp, so a non-improving submission still
    // writes. It costs the same as an improving update — the whole point is that it is not free.
    const tracked = board({ trackActivity: true });
    await submitAndCount(tracked, "u1", 50, T0);
    const noop = await submitAndCount(tracked, "u1", 1, new Date(T0.getTime() + 1000));
    expect(noop).toBe(DEFAULT_WORKLOAD.rowsWrittenPerSubmissionPerWindow);
  });

  test("a first-ever insert costs one more row than a steady-state update — it writes both indexes", async () => {
    const first = await submitAndCount(board(), "u1", 10, T0);
    // The insert writes the row + the unique-player index + the rank index (3); a later update rewrites
    // only the row + the rank index (2). And the schema pays no autoincrement tax: a plain INTEGER
    // PRIMARY KEY costs one row per insert where `autoincrement` would cost two (the sqlite_sequence row).
    await env.DB.exec("CREATE TABLE probe_auto (id integer primary key autoincrement, v integer)");
    await env.DB.exec("CREATE TABLE probe_plain (id integer primary key, v integer)");
    const auto = (await env.DB.prepare("INSERT INTO probe_auto (v) VALUES (1)").run()).meta.rows_written;
    const plain = (await env.DB.prepare("INSERT INTO probe_plain (v) VALUES (1)").run()).meta.rows_written;

    console.log(
      [
        "",
        "=== rows_written (Miniflare D1) ===",
        `  first insert        : ${first}`,
        `  model (steady-state): ${DEFAULT_WORKLOAD.rowsWrittenPerSubmissionPerWindow}`,
        `  autoincrement pk    : ${auto}   plain pk: ${plain}   (the sequence tax we avoid)`,
      ].join("\n"),
    );
    expect(first).toBe(DEFAULT_WORKLOAD.rowsWrittenPerSubmissionPerWindow + 1);
    expect(auto - plain).toBe(1);
  });
});
