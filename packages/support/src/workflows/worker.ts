// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import type { SupportAi } from "../ai/classify";
import { SupportConfig } from "../config/config";
import { resolveCategories } from "../data/categories";
import { supportDatabase } from "../data/tables";
import { runClassification } from "./classify";

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
    await step.do(`classify-${event.payload.messageId}`, async () => {
      await runClassification(deps, event.payload.messageId);
    });
  }
}
