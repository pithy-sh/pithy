// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isRetained, type PurgeContext, type PurgeStep } from "@pithy-sh/core/src/capability/purge";
import {
  classifiedSteps,
  type TerminalErrorConstructor,
  type WorkflowStepLike,
} from "@pithy-sh/core/src/workflow/faults";
import {
  completeOrganizationPurge,
  type DueOrganizationPurge,
  dueOrganizationPurges,
  type OrganizationLifecycleDeps,
  organizationPurgeSubject,
  recordOrganizationPurgeFailure,
  recordOrganizationPurgeStep,
} from "../lifecycle/transitions";
import { organizationWorkflowRetry } from "./retryPolicy";
import { ORGANIZATION_CAPABILITY, type OrganizationPurgeDueParams, type OrganizationPurgeParams } from "./specs";

/**
 * The organization purge, as steps (#623) — the bodies `./workflow.ts` hands a Workflow's step runner to.
 *
 * 1. **`due`** — is the organization deleted, and has its window closed? A restored one, one inside its window, and
 *    one already erased all end the run here, having erased nothing.
 * 2. **`erase <capability>`** — one step per composed contribution for the `organization` subject, in composition
 *    order, each recording that it ran in `pithy_organization_lifecycle`. Handed to the platform's retry
 *    unclassified (`./retryPolicy.ts`): a failing contribution retries alone, and the ones that finished are
 *    served from the journal. A contribution that **retains** its rows (#814) is a `retain <capability>` step
 *    instead: it erases nothing, and records `purge_retained` with the basis it gave.
 * 3. **`erase organization`** — this capability's own contribution, last: every other capability's step may still
 *    read a membership while it erases, and this one takes the memberships with the organization.
 * 4. **`complete`** — the `purged` record and `onOrganizationPurged`. Once.
 *
 * Every step from 2 on records an audit event as well as its row (#823), which the erasure attestation cites. A step
 * that exhausts its retries is caught once, recorded in its own `fail` step with the step it stopped at, and thrown
 * on unchanged, so the instance fails exactly as it did and the record does not read as a purge still running.
 */

/** What a purge does with the organization's own records. */
export interface OrganizationPurgeOps {
  /** Whether the organization is due: deleted, with its window closed. `gone` when there is none. */
  due(organizationId: string): Promise<"due" | "not_due" | "gone">;
  /** Record that one capability's step erased its rows. */
  recordStep(organizationId: string, step: string, summary: string): Promise<void>;
  /** Record that one capability's step kept its rows, and why (#814). */
  recordRetained(organizationId: string, step: string, basis: string): Promise<void>;
  /** Write the `purged` record and fire the hook. Says whether this call wrote them. */
  complete(organizationId: string): Promise<boolean>;
  /** Record that the purge gave up at `step`, in the history and the trail (#823). */
  fail(organizationId: string, step: string): Promise<void>;
}

/** The audit events a purge owes the trail (#823). Each is the caller's to write, as every event here is. */
export interface OrganizationPurgeAudit {
  /** One step erased or kept a capability's rows. */
  step(organizationId: string, step: string, disposition: "erased" | "retained"): Promise<void>;
  /** The purge gave up at `step`. */
  failed(organizationId: string, step: string): Promise<void>;
  /** The purge finished. Written once, by whichever purge finished it. */
  purged(organizationId: string): Promise<void>;
}

/** A trail that records nothing — a purge with no audit composed. */
const UNAUDITED: OrganizationPurgeAudit = {
  step: async () => {},
  failed: async () => {},
  purged: async () => {},
};

/** The operations, over the lifecycle transitions — and the audit events the purge owes the trail. */
export function organizationPurgeOps(
  deps: OrganizationLifecycleDeps,
  audit: OrganizationPurgeAudit = UNAUDITED,
): OrganizationPurgeOps {
  return {
    due: (organizationId) => organizationPurgeSubject(deps, organizationId),
    recordStep: async (organizationId, step, summary) => {
      await recordOrganizationPurgeStep(deps, { organizationId, step, summary });
      await audit.step(organizationId, step, "erased");
    },
    recordRetained: async (organizationId, step, basis) => {
      await recordOrganizationPurgeStep(deps, { organizationId, step, summary: basis, retained: true });
      await audit.step(organizationId, step, "retained");
    },
    complete: async (organizationId) => {
      const { changed } = await completeOrganizationPurge(deps, { organizationId });
      if (changed) await audit.purged(organizationId);
      return changed;
    },
    fail: async (organizationId, step) => {
      await recordOrganizationPurgeFailure(deps, { organizationId, step });
      await audit.failed(organizationId, step);
    },
  };
}

/** What one purge did: the organization, how it ended, and the capabilities whose rows it erased. */
export interface OrganizationPurgeOutcome {
  /** The organization. */
  readonly organizationId: string;
  /** `purged`, or why nothing was erased. */
  readonly state: "purged" | "not_due" | "gone";
  /** Every step that erased its rows, in the order it ran. Empty when nothing was erased. */
  readonly erased: readonly string[];
  /** Every step that kept its rows under a stated basis (#814), in the order it ran. */
  readonly retained: readonly string[];
}

/** What one purge reads its plan from. */
export interface OrganizationPurgeRun {
  /** Every composed purge step for `organization`, this capability's own among them. */
  readonly steps: readonly PurgeStep[];
  /** This run's bindings, handed to each contribution. */
  readonly env: Record<string, unknown>;
  /** The organization's own records. */
  readonly ops: OrganizationPurgeOps;
}

/** Run one organization's purge, one step per contribution, this capability's last. See the file header. */
export async function purgeOrganization(
  run: OrganizationPurgeRun,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
  params: OrganizationPurgeParams,
): Promise<OrganizationPurgeOutcome> {
  const own = classifiedSteps(step, organizationWorkflowRetry, terminalError);
  const organizationId = params.organizationId;
  const state = await own.do("due", () => run.ops.due(organizationId));
  if (state !== "due") return { organizationId, state, erased: [], retained: [] };

  const context: PurgeContext = { subject: { type: "organization", id: organizationId }, env: run.env };
  const mine = run.steps.filter((each) => each.step === ORGANIZATION_CAPABILITY);
  const others = run.steps.filter((each) => each.step !== ORGANIZATION_CAPABILITY);
  const erased: string[] = [];
  const retained: string[] = [];
  // The step running now, so a failure records where it stopped.
  let current = "due";
  try {
    for (const each of [...others, ...mine]) {
      const { contribution } = each;
      current = each.step;
      if (isRetained(contribution)) {
        retained.push(await retainStep(step, run.ops, each.step, contribution.retain.basis, organizationId));
      } else {
        erased.push(await eraseStep(step, run.ops, each, context));
      }
    }
    current = "complete";
    await own.do("complete", () => run.ops.complete(organizationId));
    return { organizationId, state: "purged", erased, retained };
  } catch (error) {
    await recordFailure(step, run.ops, organizationId, current);
    throw error;
  }
}

/** Record where a purge gave up, in its own step, and never mask the failure that stopped it. */
async function recordFailure(
  step: WorkflowStepLike,
  ops: OrganizationPurgeOps,
  organizationId: string,
  at: string,
): Promise<void> {
  try {
    await step.do("fail", async () => {
      await ops.fail(organizationId, at);
      return at;
    });
  } catch {
    // The original failure is the one to report, and the next daily pass starts the purge again.
  }
}

/**
 * One capability's step: erase, then record that it ran, inside one step — so a step that erased and failed to
 * record is retried whole, and the second erase finds nothing.
 */
function eraseStep(
  step: WorkflowStepLike,
  ops: OrganizationPurgeOps,
  each: PurgeStep,
  context: PurgeContext,
): Promise<string> {
  return step.do(`erase ${each.step}`, async () => {
    await each.contribution.erase?.(context);
    await ops.recordStep(context.subject.id, each.step, each.contribution.summary);
    return each.step;
  });
}

/** One capability's retained step (#814): nothing is erased, and the record says the rows were kept and why. */
function retainStep(
  step: WorkflowStepLike,
  ops: OrganizationPurgeOps,
  name: string,
  basis: string,
  organizationId: string,
): Promise<string> {
  return step.do(`retain ${name}`, async () => {
    await ops.recordRetained(organizationId, name, basis);
    return name;
  });
}

/** How many purges one `start` step dispatches. */
export const ORGANIZATION_PURGE_START_PAGE = 50;

/** The default size of one daily pass. */
export const ORGANIZATION_PURGE_DUE_DEFAULT_LIMIT = 500;

/** What the daily pass reads and starts through. */
export interface OrganizationPurgeDueRun {
  /** Every organization whose purge is due, oldest first, at most `limit`. */
  due(limit: number): Promise<DueOrganizationPurge[]>;
  /** Start one organization's purge. Says whether it is running; `false` is not counted. */
  start(due: DueOrganizationPurge): Promise<boolean>;
}

/**
 * The daily pass: list every organization past its window and start a purge for each, in pages, one step each,
 * so a pass that dies part-way resumes after the page it finished.
 */
export async function startDueOrganizationPurges(
  run: OrganizationPurgeDueRun,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
  params: OrganizationPurgeDueParams,
): Promise<{ started: number }> {
  const own = classifiedSteps(step, organizationWorkflowRetry, terminalError);
  const limit = params.limit ?? ORGANIZATION_PURGE_DUE_DEFAULT_LIMIT;
  const due = await own.do("due", () => run.due(limit));
  let started = 0;
  for (let page = 0; page * ORGANIZATION_PURGE_START_PAGE < due.length; page += 1) {
    const ids = due.slice(page * ORGANIZATION_PURGE_START_PAGE, (page + 1) * ORGANIZATION_PURGE_START_PAGE);
    started += await own.do(`start ${page + 1}`, async () => {
      let running = 0;
      for (const each of ids) if (await run.start(each)) running += 1;
      return running;
    });
  }
  return { started };
}

/** The daily pass's reads, over the lifecycle transitions. */
export function dueOrganizationPurgesOf(deps: OrganizationLifecycleDeps): OrganizationPurgeDueRun["due"] {
  return (limit) => dueOrganizationPurges(deps, limit);
}
