// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type AuditEmit, noopEmit } from "@pithy-sh/core/src/audit/recorder";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { PaymentsAuditActions } from "../audit/actions";
import type { PaymentsConfig } from "../config/config";
import { PaymentsPurchase, type PurchaseEnvironment } from "../data/purchase";
import { recordReconcileRun } from "../data/reconcileRun";
import type { PurchaseStatus } from "../data/status";
import { PAYMENTS_PURCHASES_TABLE, paymentsDatabase } from "../data/tables";
import { fulfillPurchase } from "../grants/apply";
import type { PurchaseProjection } from "../projection/writer";
import { projectPurchase } from "../projection/writer";
import type { PaddleSweepReport } from "./paddleSweep";
import type { ReconcileRailAccess } from "./railAccess";
import { DEFAULT_EXPIRING_WITHIN_SECONDS, DEFAULT_STALE_AFTER_SECONDS, type PaymentsReconcileParams } from "./specs";

/**
 * The reconciliation pass: asking each store what it thinks, and repairing what disagrees.
 *
 * **Why this exists at all.** A webhook-only system rots silently. A deploy that drops requests, a Pub/Sub push
 * subscription pointing at a retired URL, a rotated signing key, a store outage — each loses events with
 * nothing surfacing anywhere. And one drift needs no incident to explain it: a subscription can simply lapse,
 * with the store deciding not to renew and telling nobody. The read path already rechecks `expiresAt` so a
 * lapsed row stops granting, but the row itself stays wrong, the renewal that *did* happen stays unheard, and
 * neither is visible until somebody complains.
 *
 * **Why a Workflow rather than a scheduled pass.** The work is hundreds of calls to rate-limited third-party
 * APIs that fail part way. A plain `scheduled()` handler is wall-clock bounded and restarts from nothing; a
 * Workflow step is journalled, so a run that dies on page forty resumes at page forty rather than re-asking
 * Apple about four thousand subscriptions. That is durable execution earning its place, not decorating a cron.
 *
 * ## The shape of a run
 *
 * Pure over injected dependencies — the step runner, the rails, the clock, and the audit emitter all arrive as
 * parameters — so the whole of it, resuming included, is tested against real D1 with fake rails and no
 * network. `workflows/worker.ts` is the durable shell that supplies the real ones.
 *
 * **Pagination is keyset, never offset**, and that is the correctness argument for the file. The selection
 * matches subscriptions that are near expiry *or* have not been verified lately, and a reconciled row stops
 * matching both — so the result set shrinks underneath the scan. With `LIMIT/OFFSET` that is the classic skip
 * bug: page two starts at row 100 of a set that just lost its first 100 members, and half the catalog is never
 * reconciled, silently. Reading `id > cursor` in id order cannot skip and cannot repeat, whatever the
 * predicate does to the rows behind the cursor.
 *
 * **Each page is one `step.do`, named from a page counter.** Step names must be identical across replays or
 * the journal is unusable, so they are derived from a counter and never from a timestamp or a row id.
 *
 * ## What is asked, and what is left alone
 *
 * **Subscriptions only.** A consumable or a non-consumable is bought once and does not drift: the single thing
 * that changes one is a refund, which arrives as its own notification on every rail. Asking a store about
 * every one-time purchase forever would be the bulk of the cost and none of the value.
 *
 * **Not the terminal states.** `expired`, `never_paid`, `refunded`, and `revoked` are states we learned *from a
 * store*, and re-asking cannot change them: a resubscription is a new transaction and therefore a new row on all
 * three rails. Excluding them is also what stops a catalog's dead subscriptions being re-fetched every night
 * forever. A row that says `active` with an expiry in the past is **not** terminal — that is precisely the row
 * whose renewal we may have missed, and it is the one this pass exists to ask about.
 *
 * ## What a failure means
 *
 * A store that **cannot be reached** (`payments/provider_unavailable`) fails the step, so the Workflow retries
 * it — the page is idempotent, so a retry re-asks and re-projects to the same place. Every other refusal is
 * about one purchase or one rail and is counted rather than thrown: an unmapped store state, a SKU no longer
 * in the catalog, a rail switched off since the row was written. A pass that aborted on the first of those
 * would leave the rest of the catalog unreconciled to preserve a tally.
 */

/** The Workflow step runner, structurally. Injectable, so a test can run a body with no durable execution. */
export interface ReconcileStep {
  /** Run a named step, or return its journalled result if this instance already completed it. */
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Purchases per page when the caller names none. Bounded so one page fits inside one minted token's life. */
const DEFAULT_PAGE_SIZE = 100;

/** Pages per run when the caller names none. Ten thousand purchases is a long pass and a sane ceiling. */
const DEFAULT_MAX_PAGES = 100;

/**
 * The statuses a pass never re-asks about. Each was reported by a store and cannot become anything else on the
 * same transaction — see the module doc on why `active` with a past expiry is deliberately not among them.
 */
const TERMINAL_STATUSES: readonly PurchaseStatus[] = ["expired", "never_paid", "refunded", "revoked"];

/** What one reconciliation run needs. Every one is a seam. */
export interface ReconcileDeps {
  /** The app database the `pithy_payments_*` tables live in. */
  d1: D1Database;
  /** The resolved catalog — the writer's product lookup and the rails' enablement come from it. */
  config: PaymentsConfig;
  /** This deployment's store environment. A refreshed sandbox purchase is refused in production, as ever. */
  environment: PurchaseEnvironment;
  /** One page's rail access, built fresh per step so each page mints its own batch tokens. */
  railAccess(now: Date): ReconcileRailAccess;
  /** The clock. */
  now(): Date;
  /** The run id minter, injected so a test is deterministic. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /**
   * The audit seam. Drift is emitted through it, because repeated drift on one rail is the signal that the
   * webhook path is broken and a tally in a log line is not something anybody queries. Defaults to core's
   * no-op, which is what a host worker with no audit capability composed gets.
   */
  emit?: AuditEmit;
  /**
   * Fulfillment for a repaired purchase — the ledger credit a `grants` product asks for.
   *
   * A pass that repaired a subscription renewal and did not credit its coins would leave the entitlement right
   * and the balance wrong, and nothing else would ever fix it: the renewal the webhook lost is the same
   * renewal this pass discovered, so whoever discovers a period is the only one who can pay for it.
   *
   * Injectable, and defaults to {@link fulfillPurchase}. Safe to run over an already-credited purchase — the
   * ref is a pure function of the purchase id and the currency, and the ledger's `ref` is UNIQUE, so a credit
   * the webhook already applied is a no-op rather than a double.
   */
  fulfill?: (projection: PurchaseProjection) => Promise<unknown>;
  /**
   * The Paddle events sweep, or undefined to skip it.
   *
   * Injected rather than built here, because it needs Paddle's credentials and its own transport and this
   * module deliberately knows nothing about any single rail — `railAccess` is the seam every other rail is
   * reached through, and the sweep is not a rail method. The Workflow worker supplies it.
   *
   * Undefined on a project that does not sell through Paddle, which is why the step below is skipped
   * entirely rather than run and reported as empty: an empty tally for a rail nobody uses reads as a rail
   * that found nothing, which is a different statement.
   */
  sweepPaddle?: () => Promise<PaddleSweepReport>;
}

/** What one purchase's reconciliation did. */
type PurchaseOutcome = "unchanged" | "drifted" | "skipped" | "failed" | "superseded";

/** What one page did. Returned through the step, so a replay restores it exactly. */
interface PageResult {
  /** The id to read after on the next page, or the previous cursor when the catalog is exhausted. */
  cursor: string | null;
  /** Rows read. */
  scanned: number;
  /** Rows a store answered for and whose state matched what was stored. */
  unchanged: number;
  /** Rows whose stored state disagreed with the store's. Repaired unless the run is a dry run. */
  drifted: number;
  /** Rows a later period has replaced. Settled once, which makes them terminal and drops them from the scan. */
  superseded: number;
  /** Rows no store could be asked about — a rail switched off, or a purchase it cannot address. */
  skipped: number;
  /** Rows a store refused to answer for. Counted, never thrown: one bad row must not end the pass. */
  failed: number;
  /** Whether this was the last page. */
  done: boolean;
}

/** The tally a run reports. */
export interface ReconcileReport {
  /**
   * The run's id — the row this pass wrote to `pithy_payments_reconcile_runs`, and the value every repair it
   * audited carries as `runId`. Minted before the first page so the events can name it.
   */
  runId: string;
  /** Pages read — one durable step each. */
  pages: number;
  /** Purchases examined. */
  scanned: number;
  /** Purchases whose stored state already matched the store's. */
  unchanged: number;
  /** Purchases whose stored state disagreed. The number that matters: a rising one means webhooks are lost. */
  drifted: number;
  /**
   * Purchases a later period of the same subscription has replaced, settled on this pass.
   *
   * Counted apart from `drifted` deliberately. A rail answers about the family's **current** transaction
   * whichever row it is asked about, so an old period compared against its own successor always looks like
   * drift — and while these were counted as drift, `drifted` measured how long the catalog had been selling
   * rather than whether webhooks were arriving. Settling makes the old row terminal, so it leaves the scan and
   * this number falls back to zero once a catalog's history has been walked through once.
   */
  superseded: number;
  /** Purchases no store could be asked about. */
  skipped: number;
  /**
   * What the Paddle events sweep found, or undefined when it did not run.
   *
   * Undefined rather than a zeroed tally, and the difference is a statement: a rail nobody sells through
   * did not sweep, where a rail that swept and found nothing is a healthy integration. Collapsing the two
   * would make "the webhooks are fine" indistinguishable from "we never looked".
   */
  swept?: PaddleSweepReport;
  /** Purchases a store refused to answer for. */
  failed: number;
  /** Whether the run stopped at its page cap with more of the catalog unexamined. */
  truncated: boolean;
  /** Whether this run only reported. */
  dryRun: boolean;
}

/** One purchase, before and after, as the drift comparison sees it. */
interface ProjectedState {
  status: PurchaseStatus;
  expiresAt: number | null;
}

/** The state a drift comparison reads off a row or a refreshed event. */
function stateOf(value: { status: PurchaseStatus; expiresAt: Date | null }): ProjectedState {
  return { status: value.status, expiresAt: value.expiresAt?.getTime() ?? null };
}

/** Whether the store's answer says something different from what is stored. */
function drifted(before: ProjectedState, after: ProjectedState): boolean {
  return before.status !== after.status || before.expiresAt !== after.expiresAt;
}

/**
 * One page of purchases to reconcile.
 *
 * The predicate is the pass's whole selection policy: a live subscription that is near or past its expiry, or
 * one nothing has verified lately. `id > cursor` in id order is what makes it resumable — see the module doc.
 */
async function readPage(
  deps: ReconcileDeps,
  params: PaymentsReconcileParams,
  cursor: string | null,
  cutoffs: { expiring: Date; stale: Date },
  limit: number,
): Promise<PaymentsPurchase[]> {
  const db = paymentsDatabase(deps.d1);
  let query = db
    .selectFrom(PAYMENTS_PURCHASES_TABLE)
    .selectAll()
    .where("type", "=", "subscription")
    .where("status", "not in", [...TERMINAL_STATUSES])
    .where((eb) =>
      eb.or([
        // Near or past its expiry: the renewal either just happened or should have.
        eb("expiresAt", "<", SQLiteDate.encode(cutoffs.expiring)),
        // Or nowhere near expiry and unverified for a while: a refund, a pause, a revocation whose
        // notification never arrived changes a subscription mid-period and dates nothing about the expiry.
        eb("updatedAt", "<", SQLiteDate.encode(cutoffs.stale)),
      ]),
    )
    .orderBy("id")
    .limit(limit);

  if (cursor !== null) query = query.where("id", ">", cursor);
  if (params.userId !== undefined) query = query.where("userId", "=", params.userId);
  if (params.rail !== undefined) query = query.where("rail", "=", params.rail);

  return (await query.execute()).map((row) => PaymentsPurchase.parse(row));
}

/**
 * Reconcile one purchase: ask its rail, compare, and project any disagreement through the **same writer** the
 * webhook and the client submission use.
 *
 * Projecting through the writer rather than updating the row is what keeps the whole design's central claim
 * true — one idempotent projection, three triggers, one row. It also means a repair re-derives the entitlement
 * rows in the same D1 transaction, so a subscription found to have lapsed stops granting in the same commit
 * that records the lapse.
 */
async function reconcileOne(
  deps: ReconcileDeps,
  runId: string,
  access: ReconcileRailAccess,
  purchase: PaymentsPurchase,
  now: Date,
  dryRun: boolean,
): Promise<PurchaseOutcome> {
  let refreshed: Awaited<ReturnType<Awaited<ReturnType<ReconcileRailAccess["providerFor"]>>["refresh"]>>;
  try {
    const provider = await access.providerFor(purchase.rail);
    refreshed = await provider.refresh(purchase, { now });
  } catch (cause) {
    // Not reaching a store is the one failure worth retrying, and the step is the unit that retries. Every
    // other refusal — a rail switched off since the row was written, credentials never provisioned, a state
    // the rail does not map — is about this purchase or this rail and would fail identically on every retry.
    if (cause instanceof PithyError && cause.payload.code === "payments/provider_unavailable") throw cause;
    return "failed";
  }

  // The store cannot address this purchase: a one-time row whose rail offers no lookup for it, or a
  // transaction the store no longer knows. Neither is evidence that anything changed, so the row stands.
  if (refreshed === undefined) return "skipped";

  /**
   * The store answered about a **different** transaction, which means this row is a period that has ended and
   * the one that replaced it is elsewhere in the table.
   *
   * Every rail's `refresh` looks up the subscription family, not the row it was handed — it has to, because a
   * renewal is a new transaction and the family is the only handle a store offers. So comparing this row
   * against that answer compares two different purchases, and it always disagrees: the old period's expiry is
   * in the past and the new one's is not. That disagreement is not drift, and counting it as drift is what made
   * a year-old subscriber contribute twelve permanent "repairs" every night.
   *
   * Settling the row once is what ends it. Projecting it `expired` at its own expiry puts it in
   * `TERMINAL_STATUSES`, so the next pass does not select it, does not ask the store about it, and does not
   * report it — and the entitlement is unaffected, because the successor grants it and the derivation reads
   * every purchase for the key.
   */
  if (refreshed.providerTransactionId !== purchase.providerTransactionId) {
    if (dryRun) return "superseded";
    try {
      await projectPurchase(
        deps.d1,
        {
          ...purchase,
          // Its own expiry, not the successor's: this row records the period it was paid for, and that period
          // ended when it said it would.
          status: "expired",
          providerEventAt: now,
          payload: { supersededBy: refreshed.providerTransactionId },
        },
        { config: deps.config, environment: deps.environment, now },
      );
    } catch (cause) {
      if (cause instanceof PithyError) return "failed";
      throw cause;
    }
    return "superseded";
  }

  const before = stateOf(purchase);
  if (dryRun) {
    return drifted(before, stateOf({ status: refreshed.status, expiresAt: refreshed.expiresAt ?? null }))
      ? "drifted"
      : "unchanged";
  }

  let projection: PurchaseProjection;
  try {
    // The owner comes from the stored row, never from the rail — the same rule every other write path obeys.
    // A refresh cannot rebind a purchase, and the writer's own owner check refuses it if it somehow tried.
    projection = await projectPurchase(
      deps.d1,
      { ...refreshed, userId: purchase.userId },
      { config: deps.config, environment: deps.environment, now },
    );
  } catch (cause) {
    // A SKU dropped from the catalog, or a sandbox row in a production database. Both are real conditions a
    // pass meets in the field, and neither is a reason to stop reconciling everything else.
    if (cause instanceof PithyError) return "failed";
    throw cause;
  }

  const after = stateOf(projection.purchase);
  if (!drifted(before, after)) return "unchanged";

  // The audit first, so the repair is on the trail whatever fulfillment does next.
  await emitDrift(deps, runId, purchase, before, after);

  /**
   * Fulfillment, on drift only.
   *
   * Every rail dates a refresh `now` — it has to, or the monotonic write rule would discard the repair — so
   * the writer reports `updated` for every row a pass touches. Keying fulfillment on that outcome would mean
   * ten thousand ledger calls per pass, each one a no-op against a ref that already exists. Drift is the
   * signal that actually distinguishes a repair from a confirmation, and a repair is the only one that can owe
   * anybody coins.
   */
  const fulfill =
    deps.fulfill ??
    ((repaired: PurchaseProjection) =>
      fulfillPurchase(deps.d1, repaired, { config: deps.config, emit: deps.emit, now: () => now.getTime() }));
  try {
    await fulfill(projection);
  } catch (cause) {
    // The purchase itself is repaired and audited, so this is not a failed reconciliation — but a credit that
    // did not land needs a human, and the tally is where a human looks. The next pass retries it against the
    // same stable ref. A non-`PithyError` is transient by construction and belongs to the step's retry.
    if (cause instanceof PithyError) return "failed";
    throw cause;
  }
  return "drifted";
}

/** Record a repaired disagreement. The one audit event that is about this deployment rather than a caller. */
async function emitDrift(
  deps: ReconcileDeps,
  runId: string,
  purchase: PaymentsPurchase,
  before: ProjectedState,
  after: ProjectedState,
): Promise<void> {
  await (deps.emit ?? noopEmit)({
    action: PaymentsAuditActions.purchaseReconciled,
    outcome: "success",
    // `warning`, not `info`: one of these is a dropped delivery, a pattern of them is a broken webhook path.
    severity: "warning",
    actorType: "service",
    actorId: PaymentsAuditActions.purchaseReconciled,
    resourceType: "purchase",
    resourceId: purchase.id,
    // Identifiers and states only. Never the refreshed payload: the trail is long-lived and queryable, and a
    // store's purchase payload is a bearer artifact.
    metadata: {
      // The pointer, and the reason the run record holds no repairs of its own: a repair is recorded here,
      // once, and the run names the tally over the set of events carrying its id. Copying the repairs into
      // the runs table would be a second audit trail with different access rules.
      runId,
      rail: purchase.rail,
      productId: purchase.productId,
      from: before.status,
      to: after.status,
      expiryChanged: before.expiresAt !== after.expiresAt,
    },
  });
}

/**
 * Run one reconciliation pass. Idempotent by construction — a second run over a reconciled catalog finds every
 * row already matching and writes nothing — so a retried Workflow step, a manual trigger after a cron, and a
 * nervous operator running it twice all reach the same place.
 */
/** What a sweep that could not run reports. Never written to a report — see `ReconcileReport.swept`. */
const EMPTY_SWEEP: PaddleSweepReport = {
  read: 0,
  projected: 0,
  ignored: 0,
  duplicate: 0,
  failed: 0,
  quarantined: [],
  cursor: null,
  gap: null,
};

export async function reconcilePayments(
  deps: ReconcileDeps,
  step: ReconcileStep,
  params: PaymentsReconcileParams = {},
): Promise<ReconcileReport> {
  const limit = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const dryRun = params.dryRun === true;

  /**
   * The run's identity and its clock, minted **once, in one journalled step**, and read back from the step's
   * return value.
   *
   * **Why a step.** A Workflow does not resume inside the step it died in; it re-executes this body from the
   * top and serves every completed step from the journal. So anything the body *computes* answers differently
   * on a resume, while everything the journal holds does not — and a run's id and its start instant are both
   * things every page behind the interruption has already been written under.
   *
   * The id was moved here first (#328): a second mint made the run record name an id no repair carried, which
   * broke the runs table's only join. The clock was left in the body one release longer, and it was the same
   * defect one field over (#331) — `startedAt` was recomputed on resume, so a run interrupted at nine and
   * resumed at three claimed to have begun six hours *after* the repairs it names. A pass's start instant is
   * not "when this attempt got going"; it is when the pass got going.
   *
   * It is also the comparison instant every page judges against, and journalling it is right there too: the
   * pages already run were selected and dated against it, and a resume that widened the windows underneath
   * them would make one pass two different queries.
   *
   * Epoch milliseconds rather than a `Date`, because a journal round-trips JSON and a `Date` would come back
   * a string on the resume and an object on the first pass — a difference that shows up as a type error six
   * frames away rather than here.
   */
  const context: { runId: string; nowMs: number } = await step.do("start-run", async () => ({
    runId: (deps.newId ?? (() => crypto.randomUUID()))(),
    nowMs: deps.now().getTime(),
  }));
  const runId = context.runId;
  const now = new Date(context.nowMs);
  const cutoffs = {
    expiring: new Date(now.getTime() + (params.expiringWithinSeconds ?? DEFAULT_EXPIRING_WITHIN_SECONDS) * 1000),
    stale: new Date(now.getTime() - (params.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS) * 1000),
  };

  const report: ReconcileReport = {
    runId,
    pages: 0,
    scanned: 0,
    unchanged: 0,
    drifted: 0,
    superseded: 0,
    skipped: 0,
    failed: 0,
    truncated: false,
    dryRun,
  };

  /**
   * The Paddle events sweep, before the pages — the repair `refresh` cannot make.
   *
   * `refresh` re-reads rows this deployment already holds, so a purchase whose webhook was never delivered
   * and which no client submitted is invisible to it forever. Paddle publishes an account-wide event
   * stream, so it can be found; no other rail here can do this.
   *
   * **First, so what it discovers is then reconciled by the same run.** A subscription the sweep projects
   * is a row the pages below will consider, which is one pass rather than two.
   *
   * Its own `step.do`, so a transient fault retries the sweep rather than losing a whole run's pages. It
   * is skipped entirely when the pass was narrowed to another rail — `--rail stripe` means Stripe.
   */
  if (deps.sweepPaddle && (params.rail === undefined || params.rail === "paddle")) {
    const swept: PaddleSweepReport = await step.do(
      "sweep-paddle",
      async () => (await deps.sweepPaddle?.()) ?? EMPTY_SWEEP,
    );
    report.swept = swept;
    if (swept.gap !== null) {
      // A cursor past Paddle's ninety-day retention. Reported on the trail rather than repaired: restarting
      // from the beginning would re-project three months, and staying silent would leave the gap forever.
      await (deps.emit ?? noopEmit)({
        action: PaymentsAuditActions.purchaseReconciled,
        outcome: "failure",
        severity: "warning",
        actorType: "service",
        actorId: "paddle",
        // The gap's own sentence, which names the window and the cursor. Nothing a sender wrote: this
        // string is composed here, from our own cursor and our own constant.
        metadata: { rail: "paddle", runId, reason: "sweep_gap", detail: swept.gap },
      });
    }
  }

  let cursor: string | null = null;
  let page = 0;

  for (;;) {
    page += 1;
    const after = cursor;
    // Zero-padded so the step names sort the way the pages ran — a Workflow's journal is read by humans too.
    const result: PageResult = await step.do(`page-${String(page).padStart(6, "0")}`, async () => {
      const rows = await readPage(deps, params, after, cutoffs, limit);
      if (rows.length === 0) {
        return {
          cursor: after,
          scanned: 0,
          unchanged: 0,
          drifted: 0,
          superseded: 0,
          skipped: 0,
          failed: 0,
          done: true,
        };
      }

      // Built inside the step, so each page mints its own batch tokens and a retry mints fresh ones rather
      // than replaying an expired pair.
      const access = deps.railAccess(now);
      const tally: Record<PurchaseOutcome, number> = {
        unchanged: 0,
        drifted: 0,
        superseded: 0,
        skipped: 0,
        failed: 0,
      };
      for (const purchase of rows) {
        tally[await reconcileOne(deps, runId, access, purchase, now, dryRun)] += 1;
      }

      return {
        cursor: (rows[rows.length - 1] as PaymentsPurchase).id,
        scanned: rows.length,
        ...tally,
        // A short page means the catalog is exhausted. A full page might still be the last one; the next step
        // reads zero rows and ends the run, which costs one cheap query and no special case.
        done: rows.length < limit,
      };
    });

    report.pages = page;
    report.scanned += result.scanned;
    report.unchanged += result.unchanged;
    report.drifted += result.drifted;
    report.superseded += result.superseded;
    report.skipped += result.skipped;
    report.failed += result.failed;
    cursor = result.cursor;

    if (result.done) break;
    if (page >= maxPages) {
      report.truncated = true;
      break;
    }
  }

  /**
   * The run, kept.
   *
   * **A run that repaired nothing is written too**, and that is the load-bearing half: *"it ran and found
   * nothing"* is the answer to *"is this integration healthy"*, and a table holding only the exceptional
   * passes makes silence ambiguous with a cron that stopped firing — which is the failure the table exists
   * to make visible.
   *
   * Its own `step.do`, so a D1 hiccup retries the write rather than losing the record of a pass that did
   * real work. The writer is idempotent on the run's id, so a replayed step lands on the row it already
   * wrote instead of counting one pass twice. It is the last step and never the first: a row claiming a
   * finish time before the pass had one would be a lie the health read would then repeat.
   *
   * `finishedAt` is read from the clock again rather than reused from `now`, because `now` is the pass's
   * comparison instant and a run over ten thousand purchases is not instantaneous.
   */
  await step.do("record-run", async () => {
    await recordReconcileRun(
      deps.d1,
      {
        id: runId,
        startedAt: now,
        finishedAt: deps.now(),
        environment: deps.environment,
        // Null is the scheduled behaviour — every enabled rail. A value means somebody narrowed the pass.
        rail: params.rail ?? null,
        report,
      },
      { now: deps.now() },
    );
    // Steps journal their return value; this one has nothing worth replaying, and returning the row would
    // put a whole record into the journal for no reader.
    return null;
  });

  return report;
}
