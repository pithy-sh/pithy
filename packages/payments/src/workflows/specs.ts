// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";
import { PaymentsRail } from "../data/rail";

/**
 * The one durable job payments owns: the reconciliation pass.
 *
 * Declared once, here. `capability.ts` derives its Workflow binding from this map, `provision/` derives the
 * host worker's `workflows` array and its cron from it, and any caller triggers it by the `payments/reconcile`
 * key. There is no second place where the binding name, the class name, or the schedule is written down, so
 * none of them can drift.
 *
 * `optional: true` because the Workflow lives in the prebuilt reconcile worker, which exists only once
 * `pithy payments provision` has run. Until then an app composing payments must still verify receipts, accept
 * webhooks, and resolve entitlements — every one of which works with no Workflow at all. An absent binding
 * degrades to a logged skip rather than a boot failure.
 */

/** The capability name — the first segment of the dispatch key and of every deployed resource name. */
export const PAYMENTS_CAPABILITY = "payments";

/** How far ahead of expiry a subscription is re-verified, when the caller names no window. Two days. */
export const DEFAULT_EXPIRING_WITHIN_SECONDS = 172_800;

/** How long a subscription may go unverified before a pass looks at it anyway. One week. */
export const DEFAULT_STALE_AFTER_SECONDS = 604_800;

/**
 * The pass's parameters. **Every field is optional, and that is a requirement rather than a convenience:** a
 * cron supplies no input, and `createEntrypoint` dispatches a scheduled job with `{}`. A schema that demanded
 * a field could never run on its own schedule.
 *
 * The two windows are the pass's whole selection policy, and they are parameters rather than config because
 * the reason to change one is always a one-off: reproducing a repair in staging without waiting for a
 * subscription to age, or sweeping wider after an outage that ate a day of deliveries.
 */
export const PaymentsReconcileParams = z
  .object({
    userId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Reconcile one user's purchases instead of the whole catalog. This is the support tool for \"my subscription isn't showing up\" — the same steps, narrowed, so the answer comes from the same code path the cron runs.",
      ),
    rail: PaymentsRail.optional().describe(
      "Reconcile one rail's purchases only. The pass to run when a single store's webhooks were interrupted, rather than paying for the other two.",
    ),
    expiringWithinSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How far ahead of its expiry a subscription is re-verified. Omitted uses two days, so a daily cron looks at every subscription at least twice before the period it paid for ends.",
      ),
    staleAfterSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How long a subscription may go unverified before a pass looks at it regardless of its expiry. Omitted uses a week. This is what catches a subscription whose state changed nowhere near a renewal — a refund, a pause, a revocation whose notification never arrived.",
      ),
    pageSize: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Purchases per durable step. Each page is one journalled step, so this is the unit of work a retry repeats. Omitted uses 100, which keeps a page inside the life of the one access token it mints.",
      ),
    maxPages: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Cap how many pages one run scans. A bound on the work, so a first pass over a very large catalog finishes rather than running until it is killed. The next run resumes from the beginning and reaches what this one did not, because a reconciled row stops matching the selection.",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Ask every store and write nothing. The safe way to answer 'how much drift is there' before letting a pass repair it, and the way to measure whether the webhook path is working at all.",
      ),
  })
  .describe("What one reconciliation run should cover. Every field optional, because a cron passes none of them.");
export type PaymentsReconcileParams = z.infer<typeof PaymentsReconcileParams>;

/**
 * Payments' durable jobs, keyed by job name.
 *
 * The schedule is daily at 04:00 UTC — offset from storage's 03:00 sweep and the secrets rotation, so three
 * hosts in one account do not contend for the same minute. Daily is the right cadence because subscription
 * expiry windows are hours wide rather than minutes wide, and because the client-submission path already gives
 * a purchaser immediate feedback: reconciliation is the repair path, never the primary one.
 *
 * It is a cron **and** a dispatch target. A pass nobody can run on demand cannot be tested in staging, and it
 * could not be the support tool the issue asks for — "my subscription isn't showing up" is answered by running
 * these exact steps for one user.
 */
export const paymentsWorkflows = {
  reconcile: {
    binding: "PAYMENTS_RECONCILE",
    className: "PaymentsReconcileWorkflow",
    params: PaymentsReconcileParams,
    schedule: "0 4 * * *",
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * Payments' jobs as a dispatch registry, keyed `payments/<job>`. Built here rather than through
 * `composeWorkflows` because the reconcile worker dispatches its own job before any project-wide registry
 * exists — and the key format comes from core's {@link workflowKey} either way, so the two cannot drift.
 */
export const paymentsWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(paymentsWorkflows).map(([job, spec]) => {
    const key = workflowKey(PAYMENTS_CAPABILITY, job);
    return [key, { key, capability: PAYMENTS_CAPABILITY, job, spec }];
  }),
);
