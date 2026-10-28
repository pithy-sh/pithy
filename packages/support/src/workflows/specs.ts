// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/**
 * The one durable job support owns, declared once.
 *
 * **Classification is a Workflow, not part of the `email()` handler**, and that is a hard constraint
 * rather than a preference. An inbound handler runs under a tight CPU budget; a model call is
 * hundreds of milliseconds of wall time it cannot spend, and a model that is slow or briefly
 * unavailable would take the *persistence* of the message down with it. So the handler does the
 * cheap, must-not-fail half — parse, bound, store — and hands off. A classification that fails
 * retries against a message that is already safely in D1.
 *
 * `optional: true`: the Workflow lives in the prebuilt support worker that `pithy support provision`
 * deploys, so a project that has not provisioned must still boot and still receive mail. An absent
 * binding degrades to a logged skip and a thread that stays `uncategorized` — which is exactly the
 * state a classification is allowed to be in.
 */

/** The capability name — the first segment of the dispatch key and of every deployed workflow name. */
export const SUPPORT_CAPABILITY = "support";

/** Which message to classify. */
export const SupportClassifyParams = z
  .object({
    messageId: z
      .string()
      .min(1)
      .describe(
        "The `pithy_support_messages.id` to classify. The Workflow reads that message, asks the model about it, appends a classification row, and denormalizes the answer onto its thread.",
      ),
  })
  .describe("The instance parameters of the classification Workflow — the one message it runs against.");
export type SupportClassifyParams = z.infer<typeof SupportClassifyParams>;

/**
 * One re-embed of the semantic message index, started by `pithy vector reprocess --index support-messages`.
 *
 * The parameters are the ones `pithy vector reprocess` sends every index, so the CLI dispatches a capability's
 * index exactly as it dispatches one `vector()` owns. There is no `filter`: the vectors carry no metadata to
 * filter on.
 */
export const SupportReprocessParams = z
  .object({
    index: z.literal("support-messages").describe("The index to re-embed. Support declares one, `support-messages`."),
    all: z
      .boolean()
      .optional()
      .describe(
        "Re-embed every inbound message, not only the ones whose stamp differs from the configured model. What a fresh index's backfill runs.",
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Messages per Workflow step. Defaults to the Vectorize upsert ceiling of 1,000."),
  })
  .describe("The instance parameters of a re-embed of the support message index.");
export type SupportReprocessParams = z.infer<typeof SupportReprocessParams>;

/** Support's durable jobs, keyed by job name. The key is the second segment of the `support/<job>` dispatch key. */
export const supportWorkflows = {
  classify: {
    binding: "SUPPORT_CLASSIFY",
    className: "SupportClassifyWorkflow",
    params: SupportClassifyParams,
    optional: true,
  },
  // Hosted beside classification, in the same prebuilt worker, because it needs the same three things: the
  // app database, the `AI` binding, and the message index. Optional for the same reason classify is.
  reprocess: {
    binding: "SUPPORT_REPROCESS",
    className: "SupportReprocessWorkflow",
    params: SupportReprocessParams,
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * Support's jobs as a dispatch registry, keyed `support/<job>`. Built here rather than through
 * `composeWorkflows` because the inbound handler dispatches from inside the capability, before any
 * project-wide registry exists — and the key format comes from core's {@link workflowKey} either
 * way, so the two cannot drift.
 */
export const supportWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(supportWorkflows).map(([job, spec]) => {
    const key = workflowKey(SUPPORT_CAPABILITY, job);
    return [key, { key, capability: SUPPORT_CAPABILITY, job, spec }];
  }),
);
