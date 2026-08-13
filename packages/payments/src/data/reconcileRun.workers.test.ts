// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { PaymentsReconcileRun, RECONCILE_RUN_RETENTION_DAYS, recordReconcileRun } from "./reconcileRun";

/**
 * The reconciliation run writer, against real D1 (#316).
 *
 * Retention is the half that can only be proved here. It is a range delete against a real index over real
 * rows, and a bound off by a day is not something a mock would notice — while a table that grows without
 * limit is a defect shipped into other people's production databases rather than a slow query.
 */

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;
const NOW = new Date(T0);

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
  "pithy_payments_reconcile_runs",
];

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const CLEAN = {
  pages: 1,
  scanned: 0,
  unchanged: 0,
  drifted: 0,
  superseded: 0,
  skipped: 0,
  failed: 0,
  truncated: false,
  dryRun: false,
};

function write(overrides: Partial<Parameters<typeof recordReconcileRun>[1]> = {}, now: Date = NOW) {
  return recordReconcileRun(
    env.DB,
    {
      id: "run-1",
      startedAt: now,
      finishedAt: new Date(now.getTime() + 1000),
      environment: "production",
      rail: null,
      report: CLEAN,
      ...overrides,
    },
    { now },
  );
}

async function ids(): Promise<string[]> {
  const { results } = await env.DB.prepare("select id from pithy_payments_reconcile_runs order by started_at").all<{
    id: string;
  }>();
  return results.map((row) => row.id);
}

describe("recordReconcileRun", () => {
  test("round-trips the row through the codec — dates as Dates, flags as booleans", async () => {
    const run = await write({
      rail: "apple",
      report: { ...CLEAN, pages: 3, scanned: 40, drifted: 2, truncated: true, dryRun: true },
    });
    expect(run.startedAt).toEqual(NOW);
    expect(run.finishedAt).toEqual(new Date(T0 + 1000));
    expect(run.rail).toBe("apple");
    expect(run.truncated).toBe(true);
    expect(run.dryRun).toBe(true);
    expect(run.drifted).toBe(2);
    // Parsed back through the schema a management read parses it with, so a codec that stopped decoding
    // fails here rather than in a response.
    expect(PaymentsReconcileRun.parse(PaymentsReconcileRun.encode(run))).toEqual(run);
  });

  test("is idempotent on the run's id — a replayed write updates rather than doubling", async () => {
    await write();
    const second = await write({ report: { ...CLEAN, scanned: 7 } });
    expect(await ids()).toEqual(["run-1"]);
    expect(second.scanned).toBe(7);
  });

  test("keeps a run inside the retention window", async () => {
    await write({ id: "old" }, new Date(T0 - (RECONCILE_RUN_RETENTION_DAYS - 1) * DAY));
    await write({ id: "new" });
    expect(await ids()).toEqual(["old", "new"]);
  });

  test("prunes a run past the retention window, on the write that follows it", async () => {
    // Retention lives on the writer rather than in a second scheduled job, because a job that prunes is a
    // job that can stop — and the only thing that writes here is the thing that would then stop pruning.
    await write({ id: "ancient" }, new Date(T0 - (RECONCILE_RUN_RETENTION_DAYS + 1) * DAY));
    expect(await ids()).toEqual(["ancient"]);
    await write({ id: "new" });
    expect(await ids()).toEqual(["new"]);
  });

  test("the retention window is a stated number of days, not a magic literal", async () => {
    // The AC asks for retention to be *stated*. A test that read the bound off the writer would restate
    // nothing; this pins the promise the README and the module doc both make.
    expect(RECONCILE_RUN_RETENTION_DAYS).toBe(90);
  });

  test("the database refuses a negative tally, so a broken pass cannot record an impossible run", async () => {
    await expect(
      env.DB.prepare(
        "insert into pithy_payments_reconcile_runs (id, started_at, finished_at, environment, rail, pages, scanned, unchanged, drifted, superseded, skipped, failed, truncated, dry_run, created_at) values ('bad', 0, 0, 'production', null, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0)",
      ).run(),
    ).rejects.toThrow();
  });

  test("the database refuses an environment that is neither production nor sandbox", async () => {
    // The same rule the purchases table states: a sandbox pass and a production pass are facts about
    // different money, and the constraint lives where a bad write is refused rather than where it is meant.
    await expect(
      env.DB.prepare(
        "insert into pithy_payments_reconcile_runs (id, started_at, finished_at, environment, rail, pages, scanned, unchanged, drifted, superseded, skipped, failed, truncated, dry_run, created_at) values ('bad', 0, 0, 'staging', null, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
      ).run(),
    ).rejects.toThrow();
  });
});
