// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  CloudflareInvalidResponseError,
  CloudflareRequestError,
  cloudflareRequest,
  isNotFoundError,
} from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";
import { stepFailure, type WorkflowStepFailure } from "./stepFailure";

/** Pause `ms` milliseconds between status polls. Injectable so tests run with no real delay. */
export type Sleeper = (ms: number) => Promise<void>;

export interface CloudflareWorkflowsClientConfig extends CloudflareManagerConfig {
  /** Override the poll delay (tests). Defaults to a real `setTimeout`. */
  sleeper?: Sleeper;
}

export const WorkflowInstanceStatus = z
  .enum([
    "queued",
    "running",
    "paused",
    "errored",
    "terminated",
    "complete",
    "waitingForPause",
    "waiting",
    "rollingBack",
    "unknown",
  ])
  .describe("Lifecycle state of a Cloudflare Workflow instance, from the status endpoint.");
export type WorkflowInstanceStatus = z.output<typeof WorkflowInstanceStatus>;

export const WorkflowInstance = z
  .object({
    status: WorkflowInstanceStatus.describe("The instance's current lifecycle state."),
    output: z.unknown().optional().describe("The Workflow's return value, present once `status` is `complete`."),
    error: z
      .union([z.string(), z.object({ message: z.string().optional().describe("Failure message.") }), z.null()])
      .optional()
      .describe("The instance-level failure, present when `status` is `errored` or `terminated`."),
    steps: z
      .array(z.unknown())
      .optional()
      .describe(
        "The instance's steps, each validated where it is read (`stepFailure`). Held as `unknown` here on purpose: the API has four step shapes, this client reads one field of one of them, and a shape nobody anticipated must not turn a failed Workflow into a parse error about the failure report.",
      ),
  })
  .describe("A Cloudflare Workflow instance's status, as returned by the instance-detail endpoint.");
export type WorkflowInstance = z.output<typeof WorkflowInstance>;

/** Terminal states a poll stops on. */
const TERMINAL: ReadonlySet<WorkflowInstanceStatus> = new Set(["complete", "errored", "terminated"]);

const defaultSleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A client over the Cloudflare Workflows API — the only sanctioned way to reach CF Workflows from
 * outside a Worker (CLAUDE.md: no hand-rolled CF `fetch` outside `@pithy-sh/cloudflare`). The
 * `pithy secrets` CLI uses it to trigger a per-env manager's Workflow and poll to completion: the
 * CLI never runs secret logic locally, since the master key is worker-only.
 *
 * The SDK owns transport and envelope handling. Instance status is still re-validated through
 * {@link WorkflowInstance} rather than taken from the SDK's types: the SDK narrows `output` to
 * `string | number`, but a Workflow's return value is arbitrary JSON, and the status enum is a wire
 * value we decode at the boundary like every other external input.
 */
export class CloudflareWorkflowsClient extends CloudflareManager {
  readonly #sleeper: Sleeper;

  constructor(config: CloudflareWorkflowsClientConfig) {
    super(config);
    this.#sleeper = config.sleeper ?? defaultSleeper;
  }

  getServiceType(): string {
    return "Workflows";
  }

  /** Prove reach by listing the account's Workflows; never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      for await (const _workflow of this.getClient().workflows.list({ account_id: this.accountId })) break;
      return true;
    } catch {
      return false;
    }
  }

  /** Create (trigger) a Workflow instance and return its id. */
  async createInstance(workflowName: string, params: unknown, instanceId?: string): Promise<string> {
    return cloudflareRequest(`create instance of ${workflowName}`, async () => {
      const created = await this.getClient().workflows.instances.create(workflowName, {
        account_id: this.accountId,
        params,
        ...(instanceId ? { instance_id: instanceId } : {}),
      });
      if (!created.id) {
        throw new CloudflareInvalidResponseError({ detail: `create instance of ${workflowName}: missing instance id` });
      }
      return created.id;
    });
  }

  /** Fetch an instance's status. Returns `null` on a 404 (a just-created instance can briefly lag). */
  async getInstanceStatus(workflowName: string, instanceId: string): Promise<WorkflowInstance | null> {
    const operation = `get status of ${workflowName}/${instanceId}`;
    return cloudflareRequest(operation, async () => {
      let response: unknown;
      try {
        response = await this.getClient().workflows.instances.get(instanceId, {
          account_id: this.accountId,
          workflow_name: workflowName,
        });
      } catch (error) {
        // The instance is not queryable yet — the caller keeps polling. Any other failure is real.
        if (isNotFoundError(error)) return null;
        throw error;
      }
      const parsed = WorkflowInstance.safeParse(response);
      if (!parsed.success) {
        throw new CloudflareInvalidResponseError({ detail: `${operation}: unexpected shape` });
      }
      return parsed.data;
    });
  }

  /**
   * Trigger a Workflow and poll until it reaches a terminal state. Resolves with the instance
   * `output` on `complete`; throws `cloudflare/request_failed` on `errored`/`terminated` or if the
   * poll budget is exhausted. The error never carries the dispatched params (which may be secret).
   */
  async dispatchAndPoll(
    workflowName: string,
    params: unknown,
    options: { pollIntervalMs?: number; maxPolls?: number; instanceId?: string } = {},
  ): Promise<unknown> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const maxPolls = options.maxPolls ?? 120;
    const id = await this.createInstance(workflowName, params, options.instanceId);

    for (let poll = 0; poll < maxPolls; poll++) {
      await this.#sleeper(pollIntervalMs);
      const instance = await this.getInstanceStatus(workflowName, id);
      if (!instance) continue; // not queryable yet — keep polling
      if (!TERMINAL.has(instance.status)) continue;
      if (instance.status === "complete") return instance.output;
      // The step's sentence, not the instance's. The engine writes its own prose over a terminal step's
      // error, so the instance says "a step threw an NonRetryableError" where the step says what was
      // actually wrong (pithy-sh/pithy#349). Only a sentence the kit demonstrably authored is promoted
      // into `message`; everything else stays in `detail`, which the HTTP codec strips.
      const failure = stepFailure(instance.steps);
      throw new CloudflareRequestError({
        message: failure?.sentence ?? `Workflow ${workflowName} did not complete (${instance.status}).`,
        // The remedy the step stated, and only ever alongside the step's own sentence — an action line
        // under a general fallback about durable execution would be a remedy for a problem nobody was
        // told about. `undefined` prints nothing at all, which is the whole of the no-action case.
        action: failure?.sentence === undefined ? undefined : failure.action,
        detail: `instance ${id} ended ${instance.status}: ${describeFailure(failure, instance.error)}`,
      });
    }
    throw new CloudflareRequestError({
      message: `Workflow ${workflowName} did not finish in time.`,
      detail: `instance ${id} still running after ${maxPolls} polls`,
    });
  }
}

/** The most specific instance-error text, for a failure `detail`. Never the dispatched params. */
function describeError(error: WorkflowInstance["error"]): string {
  if (!error) return "no error detail";
  if (typeof error === "string") return error;
  return error.message ?? "no error detail";
}

/**
 * Everything known about why, for the `detail` line: the failed step's name and its recorded text
 * verbatim, then the instance's own. Both, because they differ — that difference is the bug this
 * function exists because of — and `detail` is the operator's side of the boundary, where the raw
 * platform text belongs. Never the dispatched params.
 */
function describeFailure(failure: WorkflowStepFailure | null, error: WorkflowInstance["error"]): string {
  const instance = describeError(error);
  if (failure === null) return instance;
  const step = failure.step === undefined ? "step" : `step '${failure.step}'`;
  const code = failure.code === undefined ? "" : ` [${failure.code}]`;
  return `${step} raised${code} ${failure.raw} — instance error: ${instance}`;
}
