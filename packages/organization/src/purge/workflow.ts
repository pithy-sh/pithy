// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { composedCapability } from "@pithy-sh/core/src/capability/composition";
import { InternalError, messageOf } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { workflowBindingFor } from "@pithy-sh/core/src/workflow/dispatch";
import type { TerminalErrorConstructor, WorkflowStepLike } from "@pithy-sh/core/src/workflow/faults";
import { OrganizationAuditActions } from "../audit/actions";
import { isOrganizationCapability, type OrganizationCapability } from "../capability";
import { organizationDatabase } from "../data/tables";
import type { OrganizationLifecycleDeps } from "../lifecycle/transitions";
import {
  dueOrganizationPurgesOf,
  type OrganizationPurgeAudit,
  type OrganizationPurgeDueRun,
  type OrganizationPurgeOutcome,
  organizationPurgeOps,
  purgeOrganization,
  startDueOrganizationPurges,
} from "./run";
import {
  ORGANIZATION_PURGE_BINDING,
  ORGANIZATION_PURGE_KEY,
  OrganizationPurgeDueParams,
  OrganizationPurgeParams,
} from "./specs";
import { startOrganizationPurgeInstance } from "./start";

/**
 * The organization purge's two Workflow bodies (#623) — run by classes **the adopter's own Worker** exports,
 * beside the `createEntrypoint` it already exports, because a purge runs every composed capability's contribution
 * and those exist nowhere else:
 *
 *   // apps/api/src/index.ts
 *   import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
 *   import { NonRetryableError } from "cloudflare:workflows";
 *   import { runOrganizationPurge, runOrganizationPurgeDue } from "@pithy-sh/organization/src/purge/workflow";
 *
 *   export class OrganizationPurgeWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
 *     override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
 *       return runOrganizationPurge(this.env, event, step, NonRetryableError);
 *     }
 *   }
 *   export class OrganizationPurgeDueWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
 *     override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
 *       return runOrganizationPurgeDue(this.env, event, step, NonRetryableError);
 *     }
 *   }
 *
 * plus a `workflows` entry binding `ORGANIZATION_PURGE` and `ORGANIZATION_PURGE_DUE` to them and the daily cron —
 * `docs/organization-lifecycle.md` has the stanza. **The class is the adopter's, the body is the kit's**, the split
 * `@pithy-sh/auth`'s purge has, for the same reason.
 */

/** What a Workflow event hands a body. */
interface PurgeEvent {
  readonly payload?: unknown;
  readonly workflowName?: string;
  readonly instanceId?: string;
}

/** The lifecycle dependencies for a run with no request: this env, and the composition's hooks. */
function lifecycleFor(
  organization: OrganizationCapability,
  env: Record<string, unknown>,
  log: Logger,
): OrganizationLifecycleDeps {
  const d1 = env.DB;
  if (typeof d1 !== "object" || d1 === null) {
    throw new InternalError({
      message: "The organization database is not bound, so the purge could not run.",
      action: "Bind the DB D1 database to the Worker that runs the organization purge.",
      detail: "the organization purge found no DB binding on the env",
    });
  }
  return {
    db: organizationDatabase(d1 as D1Database),
    d1: d1 as D1Database,
    hooks: organization.organizationLifecycleHooks,
    log,
  };
}

/** This run's logger, bound to the instance an operator reads it under. */
function runLog(env: Record<string, unknown>, event: PurgeEvent, name: string): Logger {
  return bindWorkflowContext(createWorkerLogger({ name }), {
    workflow: event.workflowName ?? name,
    instance: event.instanceId ?? "unknown",
    env: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown",
  });
}

/**
 * The trail's record of a purge (#823): each step with its disposition, a failure with where it stopped, and the
 * end, written once by whichever purge finished it. Each in the organization's own chain, so the attestation cites
 * them there. A step's name and disposition only: nothing about the organization beyond its id.
 */
export function purgeAudit(emit: AuditEmit): OrganizationPurgeAudit {
  const event = (organizationId: string) =>
    ({
      outcome: "success",
      actorType: "system",
      actorId: null,
      tenant: organizationId,
      resourceType: "organization",
      resourceId: organizationId,
    }) as const;
  return {
    step: (organizationId, step, disposition) =>
      emit({ ...event(organizationId), action: OrganizationAuditActions.purgeStep, metadata: { step, disposition } }),
    failed: (organizationId, step) =>
      emit({
        ...event(organizationId),
        action: OrganizationAuditActions.purgeFailed,
        severity: "warning",
        metadata: { step },
      }),
    purged: (organizationId) =>
      emit({ ...event(organizationId), action: OrganizationAuditActions.purged, severity: "warning" }),
  };
}

/** Purge one organization: every composed contribution, one step each, this capability's last. See `./run.ts`. */
export async function runOrganizationPurge(
  env: Record<string, unknown>,
  event: PurgeEvent,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
): Promise<OrganizationPurgeOutcome> {
  const params = OrganizationPurgeParams.parse(event.payload ?? {});
  const organization = composedCapability<OrganizationCapability>("organization", isOrganizationCapability);
  const lifecycle = lifecycleFor(organization, env, runLog(env, event, "organization:purge"));
  const emit = organization.auditFor(env);
  return purgeOrganization(
    { steps: organization.organizationPurgeSteps, env, ops: organizationPurgeOps(lifecycle, purgeAudit(emit)) },
    step,
    terminalError,
    params,
  );
}

/** The daily pass: start a purge for every organization past its window. See `./run.ts`. */
export async function runOrganizationPurgeDue(
  env: Record<string, unknown>,
  event: PurgeEvent,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
): Promise<{ started: number }> {
  const params = OrganizationPurgeDueParams.parse(event.payload ?? {});
  const organization = composedCapability<OrganizationCapability>("organization", isOrganizationCapability);
  const log = runLog(env, event, "organization:purge-due");
  const lifecycle = lifecycleFor(organization, env, log);
  return startDueOrganizationPurges(
    { due: dueOrganizationPurgesOf(lifecycle), start: organizationPurgeStarter(env, log) },
    step,
    terminalError,
    params,
  );
}

/**
 * How the daily pass starts one organization's purge: under the id the deletion names, so a purge a hard deletion
 * already started today is the same instance. It answers whether the purge is running, and the pass counts that;
 * a Worker that has not bound the purge, and a start that failed, each log the skip and answer `false`.
 */
export function organizationPurgeStarter(
  env: Record<string, unknown>,
  log: Logger,
  now: () => Date = () => new Date(),
): OrganizationPurgeDueRun["start"] {
  return async (due) => {
    const binding = workflowBindingFor(env, ORGANIZATION_PURGE_BINDING);
    if (!binding) {
      log.warn("workflow skipped", {
        workflow: ORGANIZATION_PURGE_KEY,
        binding: ORGANIZATION_PURGE_BINDING,
        reason: "binding absent — the organization purge Workflow is not bound",
      });
      return false;
    }
    try {
      await startOrganizationPurgeInstance(binding, {
        organizationId: due.organizationId,
        deletedAt: due.deletedAt,
        at: now(),
      });
      return true;
    } catch (error) {
      log.warn("workflow skipped", {
        workflow: ORGANIZATION_PURGE_KEY,
        binding: ORGANIZATION_PURGE_BINDING,
        reason: messageOf(error),
      });
      return false;
    }
  };
}
