// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { PurchaseEnvironment } from "./purchase";
import { PaymentsRail } from "./rail";
import { PAYMENTS_RECONCILE_RUNS_TABLE, paymentsDatabase } from "./tables";

/**
 * One reconciliation pass, kept — the row in `pithy_payments_reconcile_runs`.
 *
 * **Reconciliation is the compensating control for a delivery mechanism that is known to fail.** Webhooks are
 * dropped, delayed and delivered out of order, which is the whole reason the pass exists. So the run that
 * *repaired* something is the most operationally valuable event this capability produces: it is the proof that
 * a delivery went missing and that a customer was briefly wrong.
 *
 * Before this table, that was unobservable after the fact. The pass wrote its tally to a `Logger` and its
 * repairs to an `AuditEmit`, and *"has reconciliation been running"* had no answer but reading logs, while
 * *"what did it fix last month"* had none at all. An adopter could not tell a healthy integration from one
 * whose cron stopped firing, because a silent nightly job and a job that is not running look identical.
 *
 * ## A run is a summary, not a second audit trail
 *
 * An audit event is one thing that happened; a run is the statement over many — started, finished, how much
 * was compared, how much was repaired, what failed. That tally cannot be reconstructed by grouping events,
 * because nothing in the events says where one pass ended and the next began.
 *
 * So the repairs stay in the audit trail, once, and **the run points at them rather than copying them**: the
 * run's `id` travels on every `payments/purchase_reconciled` event the pass emits, as `runId`. Copying the
 * repairs here would build a second, weaker copy of the trail inside a table with different access rules —
 * the mistake `admin/coverage.ts` refuses on the webhook log for the same reason.
 *
 * ## A clean run is stored
 *
 * *"It ran and found nothing"* is the answer to *"is it healthy"*. Storing only the passes that repaired
 * something would make silence ambiguous — indistinguishable from a cron that stopped firing, which is
 * precisely the failure this table exists to make visible.
 *
 * ## Retention
 *
 * {@link RECONCILE_RUN_RETENTION_DAYS} days, pruned by the writer on every run. Runs are small and frequent —
 * a daily cron is one row a day — so the table is bounded by the schedule rather than by the catalog, and a
 * ninety-day window covers "did it run last quarter" while never growing without limit. It is stated here and
 * enforced in {@link recordReconcileRun}, rather than left to be discovered when a table is large.
 *
 * ## No provider payload, and structurally so
 *
 * Every field below is a count, a timestamp, an enum or this deployment's own id. There is no column a
 * store's response could be written into, so a run record cannot carry one — the same control
 * `admin/read.ts` applies to a purchase by never selecting `payload`, taken one step further by never
 * having the column.
 */

/** How long a run record is kept. Days, pruned by the writer — see the module doc. */
export const RECONCILE_RUN_RETENTION_DAYS = 90;

/** One reconciliation pass, as stored. `z.output` is the app shape; `z.input` is the SQLite row. */
export const PaymentsReconcileRun = z
  .object({
    id: z.string().describe("The run's UUID. Travels on every repair the pass audits, as `runId`."),
    startedAt: SQLiteDate.describe("When the pass began, from the run's own clock."),
    finishedAt: SQLiteDate.describe("When the pass finished. Equal to `startedAt` for a run that read nothing."),
    environment: PurchaseEnvironment.describe(
      "The store environment the host was deployed to. A sandbox pass and a production pass are different facts about different money, and a table that mixed them would answer the health question wrong.",
    ),
    rail: PaymentsRail.nullable().describe(
      "The single store this pass was narrowed to, or null for every enabled rail. Null is the scheduled behavior; a value means somebody ran it by hand against one store.",
    ),
    pages: z.number().int().describe("Durable steps read — one per page of purchases."),
    scanned: z.number().int().describe("Purchases examined."),
    unchanged: z.number().int().describe("Purchases whose stored state already matched the store's."),
    drifted: z
      .number()
      .int()
      .describe(
        "Purchases whose stored state disagreed and was repaired. The number that matters: a rising one means webhooks are being lost.",
      ),
    superseded: z
      .number()
      .int()
      .describe(
        "Old periods a later transaction has replaced, settled on this pass. Falls back to zero once a catalog's history has been walked once, which is why it is counted apart from `drifted`.",
      ),
    skipped: z
      .number()
      .int()
      .describe("Purchases no store could be asked about — a rail switched off, or unaddressable."),
    failed: z
      .number()
      .int()
      .describe(
        "Purchases a store refused to answer for. Counted rather than thrown, so one bad row cannot end a pass.",
      ),
    truncated: SQLiteBoolean.describe(
      "Whether the pass stopped at its page cap with catalog left unread. True means the tally is a floor, not a total.",
    ),
    dryRun: SQLiteBoolean.describe(
      "Whether this pass only reported. A dry run repairs nothing, so its `drifted` is a finding rather than a fix.",
    ),
    createdAt: SQLiteDate.describe("When this row was written."),
  })
  .describe(
    "One reconciliation pass — when it ran, what it was narrowed to, and its tally. Never a provider payload: there is no column for one.",
  );
export type PaymentsReconcileRun = z.output<typeof PaymentsReconcileRun>;
export type PaymentsReconcileRunRow = z.input<typeof PaymentsReconcileRun>;

/** What the pass hands the writer. The row, minus the two fields the writer owns. */
export interface ReconcileRunInput {
  /** The run's id — minted before the pass so the repairs it audits can name it. */
  id: string;
  /** When the pass began. */
  startedAt: Date;
  /** When it finished. */
  finishedAt: Date;
  /** The deployment's store environment. */
  environment: PurchaseEnvironment;
  /** The rail the pass was narrowed to, or null for every enabled one. */
  rail: PaymentsRail | null;
  /** The tally, as `reconcilePayments` reports it. */
  report: {
    pages: number;
    scanned: number;
    unchanged: number;
    drifted: number;
    superseded: number;
    skipped: number;
    failed: number;
    truncated: boolean;
    dryRun: boolean;
  };
}

/**
 * Write one run record, and prune the ones past retention.
 *
 * Idempotent on the run's id: a Workflow step that wrote the row and then failed to journal its result
 * replays the whole body, and a second insert for one pass would make the health read count a pass twice.
 * `ON CONFLICT (id) DO UPDATE` is what makes the replay land on the same row it already wrote.
 *
 * The prune shares the write rather than living in a second scheduled job, because a job that prunes is a job
 * that can stop — and the only thing that ever writes here is the thing that would then also stop pruning.
 * Retention is therefore a property of the writer, and a table nobody writes to does not grow.
 */
export async function recordReconcileRun(
  d1: D1Database,
  input: ReconcileRunInput,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<PaymentsReconcileRun> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? RECONCILE_RUN_RETENTION_DAYS;
  const db = paymentsDatabase(d1);
  const row = PaymentsReconcileRun.encode({
    id: input.id,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    environment: input.environment,
    rail: input.rail,
    ...input.report,
    createdAt: now,
  });

  await withD1Retry(() =>
    db
      .insertInto(PAYMENTS_RECONCILE_RUNS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
      .values(row as any)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          finishedAt: row.finishedAt,
          pages: row.pages,
          scanned: row.scanned,
          unchanged: row.unchanged,
          drifted: row.drifted,
          superseded: row.superseded,
          skipped: row.skipped,
          failed: row.failed,
          truncated: row.truncated,
          dryRun: row.dryRun,
          // biome-ignore lint/suspicious/noExplicitAny: as above — an encoded row, not the app shape.
        } as any),
      )
      .execute(),
  );

  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  await withD1Retry(() =>
    db.deleteFrom(PAYMENTS_RECONCILE_RUNS_TABLE).where("startedAt", "<", SQLiteDate.encode(cutoff)).execute(),
  );

  const written = await db
    .selectFrom(PAYMENTS_RECONCILE_RUNS_TABLE)
    .selectAll()
    .where("id", "=", input.id)
    .executeTakeFirst();
  if (written === undefined) {
    throw new InternalError({
      message: "The reconciliation run could not be recorded.",
      action: "Retry. If it persists, check the app database for the pithy_payments_* tables.",
      detail: `Wrote reconcile run ${input.id} but could not read it back.`,
    });
  }
  return PaymentsReconcileRun.parse(written);
}
