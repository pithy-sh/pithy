// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database } from "@cloudflare/workers-types";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { workflowHostEntry } from "@pithy-sh/core/src/workflow/hostEntry";
import type { SupportAi } from "../ai/classify";
import { SupportConfig } from "../config/config";
import { resolveCategories } from "../data/categories";
import { supportDatabase } from "../data/tables";
import { runClassification } from "./classify";
import { supportWorkflowRetry } from "./retryPolicy";
import { SUPPORT_CAPABILITY } from "./specs";

/**
 * The prebuilt support worker. `pithy support provision` deploys one per environment; the adopter
 * authors no code for it. It hosts the classification Workflow — a thin durable shell around the
 * tested orchestration in `classify.ts`. The app worker receives the mail, stores it, and starts an
 * instance.
 *
 * This module imports `cloudflare:workers`, so it runs only in the Workers runtime and is excluded
 * from the node `.describe()` meta-test.
 *
 * **The effective taxonomy arrives as config, not as code.** `SUPPORT_CONFIG` carries the adopter's
 * own categories, so their `tournament_dispute` reaches the prompt without this worker importing
 * anything of theirs — which it could not do anyway, since it is deployed from this package.
 *
 * **The default export is what makes this an ES module** (#426). It exports one Workflow class and has
 * no cron, so until now it exported no default — and wrangler infers a worker's module format from
 * exactly that, so the build read it as a service worker and refused `cloudflare:workers` outright.
 * The host did not build, `pithy dev` carried on past it, and classification silently never ran. The
 * refusal it exports is the honest body for a host with no request surface; see
 * `@pithy-sh/core/src/workflow/hostEntry`.
 */

/** The support worker's env: the app database, the AI binding, and the serialized config. */
export interface SupportWorkerEnv {
  /** The app database the support tables live in. */
  DB: D1Database;
  /** The Workers AI binding. */
  AI: SupportAi;
  /** The resolved support config as a JSON string, filled at provision. */
  SUPPORT_CONFIG?: string;
}

/** Classify one stored message and write the result. */
export class SupportClassifyWorkflow extends WorkflowEntrypoint<SupportWorkerEnv, { messageId: string }> {
  override async run(event: WorkflowEvent<{ messageId: string }>, step: WorkflowStep): Promise<void> {
    const config = SupportConfig.parse(this.env.SUPPORT_CONFIG ? JSON.parse(this.env.SUPPORT_CONFIG) : {});
    const deps = {
      db: supportDatabase(this.env.DB),
      ai: this.env.AI,
      categories: resolveCategories(config.categories),
      ai_config: config.ai,
      archiveSpam: config.guard.archiveSpam,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    };

    // One step. The unit of retry is the whole judgement, because a classification that half-ran —
    // a history row with no thread update — would leave the inbox disagreeing with its own audit
    // trail, and re-running the model is cheap enough that splitting it buys nothing.
    // Under `supportWorkflowRetry`: a model that could not be reached re-drives, and everything else
    // fails at once. `classifyMessage` already refuses to throw on a bad *answer*, so the only fault
    // that reaches this classifier as retryable is the binding not answering. See `retryPolicy.ts`.
    await classifiedSteps(step, supportWorkflowRetry, NonRetryableError).do(
      `classify-${event.payload.messageId}`,
      async () => {
        await runClassification(deps, event.payload.messageId);
      },
    );
  }
}

/**
 * The module's default export, and therefore its format. See `hostEntry` for why a Workflow host needs
 * one at all, and why this one refuses rather than being empty: nothing reaches this worker over HTTP —
 * the app worker stores the message and starts an instance on the `SUPPORT_CLASSIFY` binding.
 */
export default workflowHostEntry(SUPPORT_CAPABILITY);
