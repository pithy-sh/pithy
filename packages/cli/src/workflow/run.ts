// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { stepFailure } from "@pithy-sh/cloudflare/src/workflows/stepFailure";
import type {
  CloudflareWorkflowsClient,
  WorkflowInstanceStatus,
} from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { ConflictError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { instanceIdFor } from "@pithy-sh/core/src/workflow/dispatch";
import type { RegisteredWorkflow } from "@pithy-sh/core/src/workflow/spec";

/** What starting an instance needs from Cloudflare. */
export type InstanceStarter = Pick<CloudflareWorkflowsClient, "createInstance">;
/** What reading an instance needs from Cloudflare. */
export type InstanceReader = Pick<CloudflareWorkflowsClient, "getInstanceStatus">;

/** One start of a job's deployed Workflow. */
export interface TriggerJobOptions {
  /** The job. */
  entry: RegisteredWorkflow;
  /** Its deployed Workflow name in the target environment. */
  workflow: string;
  /** The params, already parsed through the job's schema. */
  params: unknown;
  /** `--id`. Over the spec's `instanceId`. */
  id?: string;
  /** Start nothing; make every refusal the real run would. */
  dryRun: boolean;
  /** The account's Workflows. */
  workflows: InstanceStarter & InstanceReader;
  /** The `pithy workflow status` line that follows an instance, for the duplicate refusal. */
  follow?: (instanceId: string) => string;
}

/** What a trigger did. */
export interface TriggerOutcome {
  /** The instance id: Cloudflare's answer, or the id a dry run would ask for, or `null` when Cloudflare would pick. */
  instanceId: string | null;
  /** Whether an instance was started. `false` under a dry run. */
  started: boolean;
}

/** Whether the Workflow holds an instance under `id`. */
async function taken(options: TriggerJobOptions, id: string): Promise<boolean> {
  return (await options.workflows.getInstanceStatus(options.workflow, id)) !== null;
}

/** The refusal for an id the Workflow already holds. */
function duplicate(options: TriggerJobOptions, id: string): ConflictError {
  return new ConflictError({
    message: `${options.workflow} already has an instance named "${id}".`,
    action:
      options.follow === undefined
        ? "Pass another --id."
        : `Pass another --id, or follow that one with ${options.follow(id)}.`,
  });
}

/** The id a start asks for: `--id`, else the spec's `instanceId`, else none. */
function requestedInstanceId(entry: RegisteredWorkflow, params: unknown, id: string | undefined): string | undefined {
  return instanceIdFor(entry, id === undefined ? {} : { id }, params);
}

/**
 * Start one instance of a job's deployed Workflow. A start Cloudflare refuses under an id the Workflow already
 * holds is reported as that conflict; any other failure is rethrown as it came.
 */
export async function triggerJob(options: TriggerJobOptions): Promise<TriggerOutcome> {
  const id = requestedInstanceId(options.entry, options.params, options.id);
  if (options.dryRun) {
    if (id !== undefined && (await taken(options, id))) throw duplicate(options, id);
    return { instanceId: id ?? null, started: false };
  }
  try {
    return { instanceId: await options.workflows.createInstance(options.workflow, options.params, id), started: true };
  } catch (error) {
    if (id !== undefined && (await taken(options, id).catch(() => false))) throw duplicate(options, id);
    throw error;
  }
}

/** One instance looked up by id. */
export interface JobStatusOptions {
  /** The deployed Workflow name. */
  workflow: string;
  /** The instance id. */
  instanceId: string;
  /** The account's Workflows. */
  workflows: InstanceReader;
}

/** What an instance reports. */
export interface JobStatusReport {
  /** Its lifecycle state. */
  status: WorkflowInstanceStatus;
  /** The Workflow's return value, once `complete`. */
  output?: unknown;
  /** Why it failed: the failed step's text, else the instance's own error. `null` when nothing failed. */
  error: string | null;
  /** The step that failed, when one did and the engine named it. */
  failedStep: string | null;
}

/** Look one instance up. An id the Workflow does not hold is `core/not_found`. */
export async function jobStatus(options: JobStatusOptions): Promise<JobStatusReport> {
  const instance = await options.workflows.getInstanceStatus(options.workflow, options.instanceId);
  if (instance === null) {
    throw new NotFoundError({
      message: `${options.workflow} has no instance named "${options.instanceId}".`,
      action: "Check the instance id the trigger printed, and the --env it ran in.",
    });
  }
  const failure = stepFailure(instance.steps);
  const own = typeof instance.error === "string" ? instance.error : (instance.error?.message ?? null);
  return {
    status: instance.status,
    ...(instance.output === undefined ? {} : { output: instance.output }),
    error: failure ? (failure.sentence ?? failure.raw) : own,
    failedStep: failure?.step ?? null,
  };
}
