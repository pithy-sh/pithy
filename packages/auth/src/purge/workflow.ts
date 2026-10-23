// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { composedCapability } from "@pithy-sh/core/src/capability/composition";
import { messageOf } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { workflowBindingFor } from "@pithy-sh/core/src/workflow/dispatch";
import type { TerminalErrorConstructor, WorkflowStepLike } from "@pithy-sh/core/src/workflow/faults";
import type { EmailEnqueueEnv } from "@pithy-sh/email/src/capability";
import { enqueueFromEnv } from "@pithy-sh/email/src/send/fromComposition";
import { type AuthCapability, isAuthCapability } from "../capability";
import { authDatabase } from "../data/tables";
import { resolveDb } from "../http/resolve";
import type { LifecycleDeps } from "../lifecycle/transitions";
import { duePurgesOf, type PurgeDueRun, type PurgeOutcome, purgeOps, purgeUser, startDuePurges } from "./run";
import { AUTH_PURGE_BINDING, AUTH_PURGE_KEY, AuthPurgeDueParams, AuthPurgeParams } from "./specs";
import { startPurgeInstance } from "./start";

/**
 * The purge's two Workflow bodies (#622) — run by classes **the adopter's own Worker** exports, beside the
 * `createEntrypoint` it already exports, because a purge runs every composed capability's contribution and
 * those exist nowhere else:
 *
 *   // apps/api/src/index.ts
 *   import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
 *   import { NonRetryableError } from "cloudflare:workflows";
 *   import { runAuthPurge, runAuthPurgeDue } from "@pithy-sh/auth/src/purge/workflow";
 *
 *   export class AuthPurgeWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
 *     override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
 *       return runAuthPurge(this.env, event, step, NonRetryableError);
 *     }
 *   }
 *   export class AuthPurgeDueWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
 *     override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
 *       return runAuthPurgeDue(this.env, event, step, NonRetryableError);
 *     }
 *   }
 *
 * plus a `workflows` entry binding `AUTH_PURGE` and `AUTH_PURGE_DUE` to them and the daily cron —
 * `docs/account-lifecycle.md` has the stanza. **The class is the adopter's, the body is the kit's**, the split
 * `@pithy-sh/payments`' usage pass has, for the same reason.
 *
 * Each body finds the composed auth capability the way a Workflow that sends mail finds email: the class is
 * exported from the entry that calls `createEntrypoint`, so the composition has happened in this isolate. The
 * steps, the hooks, the config and the audit recorder are on the capability; the mail is email's own enqueue.
 */

/** What a Workflow event hands a body. */
interface PurgeEvent {
  readonly payload?: unknown;
  readonly workflowName?: string;
  readonly instanceId?: string;
}

/** The lifecycle transitions' dependencies, for a run with no request: this env, and the composition's seams. */
function lifecycleFor(auth: AuthCapability, env: Record<string, unknown>, log: Logger): LifecycleDeps {
  const d1 = resolveDb(env, auth.authConfig.database);
  return {
    db: authDatabase(d1),
    d1,
    emit: auth.auditFor(env),
    config: auth.authConfig,
    hooks: auth.lifecycleHooks,
    enqueueEmail: (input) => enqueueFromEnv(env as unknown as EmailEnqueueEnv, input),
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

/** Purge one account: every composed contribution, one step each, auth's last. See `./run.ts`. */
export async function runAuthPurge(
  env: Record<string, unknown>,
  event: PurgeEvent,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
): Promise<PurgeOutcome> {
  // Parsed rather than trusted: an instance can be started by the daily pass, by a hard deletion, or by hand.
  const params = AuthPurgeParams.parse(event.payload ?? {});
  const auth = composedCapability<AuthCapability>("auth", isAuthCapability);
  const lifecycle = lifecycleFor(auth, env, runLog(env, event, "auth:purge"));
  return purgeUser({ steps: auth.purgeSteps, env, ops: purgeOps(lifecycle) }, step, terminalError, params);
}

/** The daily pass: start a purge for every account past its window. See `./run.ts`. */
export async function runAuthPurgeDue(
  env: Record<string, unknown>,
  event: PurgeEvent,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
): Promise<{ started: number }> {
  const params = AuthPurgeDueParams.parse(event.payload ?? {});
  const auth = composedCapability<AuthCapability>("auth", isAuthCapability);
  const log = runLog(env, event, "auth:purge-due");
  const lifecycle = lifecycleFor(auth, env, log);
  return startDuePurges({ due: duePurgesOf(lifecycle), start: purgeStarter(env, log) }, step, terminalError, params);
}

/**
 * How the daily pass starts one account's purge: under the id the deletion names (`./start.ts`), so a purge a hard
 * deletion already started today is the same instance, not a second one. No `notify`: the deletion's own row
 * carries it, and the purge reads it there.
 *
 * **It answers whether the purge is running**, and the pass counts that. A Worker that has not bound the purge,
 * and a start that failed, each log the skip rather than throwing inside a cron nobody watches — tomorrow's pass
 * starts it again — and answer `false`, so the pass does not report a purge it never started.
 */
export function purgeStarter(
  env: Record<string, unknown>,
  log: Logger,
  now: () => Date = () => new Date(),
): PurgeDueRun["start"] {
  return async (due) => {
    const binding = workflowBindingFor(env, AUTH_PURGE_BINDING);
    if (!binding) {
      log.warn("workflow skipped", {
        workflow: AUTH_PURGE_KEY,
        binding: AUTH_PURGE_BINDING,
        reason: "binding absent — the purge Workflow is not bound",
      });
      return false;
    }
    try {
      await startPurgeInstance(binding, { userId: due.userId, deletedAt: due.deletedAt, at: now() });
      return true;
    } catch (error) {
      log.warn("workflow skipped", {
        workflow: AUTH_PURGE_KEY,
        binding: AUTH_PURGE_BINDING,
        reason: messageOf(error),
      });
      return false;
    }
  };
}
