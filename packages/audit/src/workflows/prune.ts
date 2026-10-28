// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { composedCapability } from "@pithy-sh/core/src/capability/composition";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { composedRetention } from "@pithy-sh/core/src/retention/composed";
import { legalHolds } from "@pithy-sh/core/src/retention/holds";
import { type EffectiveRetention, prunesAudit } from "@pithy-sh/core/src/retention/policy";
import {
  classifiedSteps,
  type TerminalErrorConstructor,
  type WorkflowStepLike,
} from "@pithy-sh/core/src/workflow/faults";
import { type AuditCapability, isAuditCapability } from "../capability";
import { AUDIT_CHECKPOINT_BINDING } from "../chain/checkpoint";
import {
  AUDIT_PRUNE_PAGE,
  type ChainPrunePage,
  chainTenants,
  pruneChainPage,
  pruneUnchainedPage,
  type UnchainedPrunePage,
} from "../chain/prune";
import { auditDatabase } from "../data/tables";
import { auditWorkflowRetry } from "./retryPolicy";
import { AuditPruneParams } from "./specs";

/**
 * **The retention prune's Workflow body**, run by a class the adopter's own Worker exports beside the
 * `createEntrypoint` it already exports, because the prune reads the `retention` block that Worker resolved:
 *
 *   // apps/api/src/index.ts
 *   import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
 *   import { NonRetryableError } from "cloudflare:workflows";
 *   import { runAuditPrune } from "@pithy-sh/audit/src/workflows/prune";
 *
 *   export class AuditPruneWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
 *     override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
 *       return runAuditPrune(this.env, event, step, NonRetryableError);
 *     }
 *   }
 *
 * plus a `workflows` entry binding `AUDIT_PRUNE` to it and the daily cron.
 *
 * **A legal hold on a tenant's trail stops it.** Before every page of a chain the pass asks whether a hold stands on
 * that tenant's trail, each ask its own step, so a hold placed while a pass runs stops it at its next page. The
 * chain is left whole until the hold is released, and the next pass after that prunes it.
 */

/** What one pass reads and removes through. */
export interface AuditPruneRun {
  /** Whether the policy prunes anything at all. Asked inside a step, so a replay serves the answer it got. */
  prunes(): Promise<boolean>;
  /** Whether a checkpoint bucket is bound. Without one nothing chained is pruned: no tombstone could be written. */
  readonly checkpointed: boolean;
  /** Every chain the trail holds. */
  tenants(): Promise<(string | null)[]>;
  /** Whether a legal hold stands on a tenant's trail. Throws when it cannot say. */
  held(tenant: string | null): Promise<boolean>;
  /** Prune one page of one chain. */
  chainPage(tenant: string | null, afterSeq: number): Promise<ChainPrunePage>;
  /** Prune one page of the rows that carry no chain. */
  unchainedPage(afterId: number): Promise<UnchainedPrunePage>;
}

/** What one pass did. */
export interface AuditPruneOutcome {
  /** How many chained events were removed, each run behind a tombstone. */
  pruned: number;
  /** How many runs were past their windows and left in place, because they did not verify. */
  refused: number;
  /** How many rows that carry no chain were removed. */
  unchained: number;
  /** How many chains a legal hold kept whole. */
  held: number;
}

/** How many pages of one chain a pass takes, unless the trigger says otherwise. */
export const AUDIT_PRUNE_DEFAULT_PAGES = 20;

/**
 * One pass: every chain, a page per step, each page behind its own hold check; then the unchained rows. A pass that
 * dies part-way resumes after the step it finished, and a page repeated deletes nothing twice, because what it
 * removed is gone and its tombstone is found rather than written again.
 */
export async function pruneAuditTrail(
  run: AuditPruneRun,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
  params: AuditPruneParams = {},
): Promise<AuditPruneOutcome> {
  const outcome: AuditPruneOutcome = { pruned: 0, refused: 0, unchained: 0, held: 0 };
  const own = classifiedSteps(step, auditWorkflowRetry, terminalError);
  if (!(await own.do("policy", () => run.prunes()))) return outcome;
  const pages = params.pages ?? AUDIT_PRUNE_DEFAULT_PAGES;

  if (run.checkpointed) {
    const tenants = await own.do("tenants", () => run.tenants());
    for (const [index, tenant] of tenants.entries()) {
      let afterSeq = 0;
      for (let page = 1; page <= pages; page++) {
        if (await own.do(`hold ${index + 1} ${page}`, () => run.held(tenant))) {
          outcome.held++;
          break;
        }
        const done = await own.do(`chain ${index + 1} ${page}`, () => run.chainPage(tenant, afterSeq));
        outcome.pruned += done.pruned;
        outcome.refused += done.refused;
        if (done.next === null) break;
        afterSeq = done.next;
      }
    }
  }

  let afterId = 0;
  for (let page = 1; page <= pages; page++) {
    const done = await own.do(`unchained ${page}`, () => run.unchainedPage(afterId));
    outcome.unchained += done.deleted;
    if (done.next === null) break;
    afterId = done.next;
  }
  return outcome;
}

/** The pass over one env: its audit database, its checkpoint bucket, its holds, and the policy resolved at assembly. */
export function auditPruneRun(
  env: Record<string, unknown>,
  database: string,
  policy: () => EffectiveRetention | null,
  now: () => Date = () => new Date(),
): AuditPruneRun {
  const binding = env[database];
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: "The audit database is not bound, so the prune could not run.",
      action: `Bind the ${database} D1 database to the Worker that runs the audit prune.`,
      detail: `the audit prune found no ${database} binding on the env`,
    });
  }
  const db = auditDatabase(binding as D1Database);
  const found = env[AUDIT_CHECKPOINT_BINDING];
  const bucket = typeof found === "object" && found !== null ? (found as R2Bucket) : null;
  const holds = legalHolds(env);
  const held = (tenant: string | null) => holds.held("audit", tenant);
  return {
    prunes: async () => {
      const retention = policy();
      return retention !== null && prunesAudit(retention);
    },
    checkpointed: bucket !== null,
    tenants: () => chainTenants(db),
    held,
    chainPage: (tenant, afterSeq) => {
      const retention = policy();
      if (!bucket || !retention) return Promise.resolve({ pruned: 0, refused: 0, next: null });
      return pruneChainPage(db, bucket, { tenant, retention, now: now(), afterSeq, limit: AUDIT_PRUNE_PAGE });
    },
    unchainedPage: (afterId) => {
      const retention = policy();
      if (!retention) return Promise.resolve({ deleted: 0, next: null });
      return pruneUnchainedPage(db, { retention, now: now(), afterId, limit: AUDIT_PRUNE_PAGE, held });
    },
  };
}

/** What a Workflow event hands a body. */
interface PruneEvent {
  readonly payload?: unknown;
  readonly workflowName?: string;
  readonly instanceId?: string;
}

/** The prune pass, over this Worker's composition and the `retention` block it resolved. */
export async function runAuditPrune(
  env: Record<string, unknown>,
  event: PruneEvent,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
): Promise<AuditPruneOutcome> {
  const params = AuditPruneParams.parse(event.payload ?? {});
  const audit = composedCapability<AuditCapability>("audit", isAuditCapability);
  const log = bindWorkflowContext(createWorkerLogger({ name: "audit" }), {
    workflow: event.workflowName ?? "audit:prune",
    instance: event.instanceId ?? "unknown",
    env: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown",
  });
  const run = auditPruneRun(env, audit.auditDatabase, composedRetention);
  if (!run.checkpointed) {
    log.warn("audit prune leaves the chains whole", { reason: `no ${AUDIT_CHECKPOINT_BINDING} binding` });
  }
  const outcome = await pruneAuditTrail(run, step, terminalError, params);
  log.info("audit prune finished", { ...outcome });
  return outcome;
}
