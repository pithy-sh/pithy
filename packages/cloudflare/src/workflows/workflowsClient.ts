import { z } from "zod";
import { CloudflareInvalidResponseError, CloudflareNotConfiguredError, CloudflareRequestError } from "../client/errors";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** A `fetch`-shaped function. Injectable so tests drive the client without a network. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Pause `ms` milliseconds between status polls. Injectable so tests run with no real delay. */
export type Sleeper = (ms: number) => Promise<void>;

export interface CloudflareWorkflowsClientConfig {
  accountId: string;
  apiToken: string;
  /** Override the network layer (tests). Defaults to the global `fetch`. */
  fetcher?: Fetcher;
  /** Override the poll delay (tests). Defaults to a real `setTimeout`. */
  sleeper?: Sleeper;
}

export const WorkflowInstanceStatus = z
  .enum(["queued", "running", "paused", "errored", "terminated", "complete", "waitingForPause", "waiting", "unknown"])
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
  })
  .describe("A Cloudflare Workflow instance's status, as returned by the instance-detail endpoint.");
export type WorkflowInstance = z.output<typeof WorkflowInstance>;

/** Terminal states a poll stops on. */
const TERMINAL: ReadonlySet<WorkflowInstanceStatus> = new Set(["complete", "errored", "terminated"]);

/** The CF API envelope. Internal — only `result` is surfaced (validated by the caller). */
const apiEnvelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z.unknown(),
});

function errorText(errors: Array<{ code: number; message: string }>): string {
  return errors.length === 0 ? "no error detail" : errors.map((e) => `${e.code}: ${e.message}`).join("; ");
}

const defaultSleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A thin client over the Cloudflare Workflows REST API — the only sanctioned way to reach the CF
 * API for Workflows (CLAUDE.md: no hand-rolled CF `fetch` outside `@pithy-sh/cloudflare`). The
 * `pithy secrets` CLI uses it to trigger a per-env manager's Workflow and poll to completion: the
 * CLI never runs secret logic locally, since the master key is worker-only.
 *
 * Endpoints: https://developers.cloudflare.com/workflows/.
 */
export class CloudflareWorkflowsClient {
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #fetcher: Fetcher;
  readonly #sleeper: Sleeper;

  constructor(config: CloudflareWorkflowsClientConfig) {
    if (!config.accountId || !config.apiToken) {
      throw new CloudflareNotConfiguredError({ detail: "CloudflareWorkflowsClient needs accountId and apiToken." });
    }
    this.#accountId = config.accountId;
    this.#apiToken = config.apiToken;
    this.#fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
    this.#sleeper = config.sleeper ?? defaultSleeper;
  }

  /** Create (trigger) a Workflow instance and return its id. */
  async createInstance(workflowName: string, params: unknown, instanceId?: string): Promise<string> {
    const body: Record<string, unknown> = { params };
    if (instanceId) body.id = instanceId;
    const envelope = await this.#request(
      `create instance of ${workflowName}`,
      "POST",
      `workflows/${workflowName}/instances`,
      body,
    );
    const result = z.object({ id: z.string() }).safeParse(envelope.result);
    if (!result.success) {
      throw new CloudflareInvalidResponseError({ detail: `create instance of ${workflowName}: missing instance id` });
    }
    return result.data.id;
  }

  /** Fetch an instance's status. Returns `null` on a 404 (a just-created instance can briefly lag). */
  async getInstanceStatus(workflowName: string, instanceId: string): Promise<WorkflowInstance | null> {
    const response = await this.#fetcher(
      `${API_BASE}/accounts/${this.#accountId}/workflows/${workflowName}/instances/${instanceId}`,
      { method: "GET", headers: this.#headers() },
    );
    if (response.status === 404) return null;
    const envelope = await this.#parse(`get status of ${workflowName}/${instanceId}`, response);
    const parsed = WorkflowInstance.safeParse(envelope.result);
    if (!parsed.success) {
      throw new CloudflareInvalidResponseError({
        detail: `get status of ${workflowName}/${instanceId}: unexpected shape`,
      });
    }
    return parsed.data;
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
      throw new CloudflareRequestError({
        message: `Workflow ${workflowName} did not complete (${instance.status}).`,
        detail: `instance ${id} ended ${instance.status}: ${describeError(instance.error)}`,
      });
    }
    throw new CloudflareRequestError({
      message: `Workflow ${workflowName} did not finish in time.`,
      detail: `instance ${id} still running after ${maxPolls} polls`,
    });
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#apiToken}`, "Content-Type": "application/json" };
  }

  async #request(
    operation: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<z.output<typeof apiEnvelope>> {
    const response = await this.#fetcher(`${API_BASE}/accounts/${this.#accountId}/${path}`, {
      method,
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    return this.#parse(operation, response);
  }

  async #parse(operation: string, response: Response): Promise<z.output<typeof apiEnvelope>> {
    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new CloudflareRequestError(
        { message: `Cloudflare request failed: ${operation}.`, detail: "non-JSON response" },
        { cause },
      );
    }
    const envelope = apiEnvelope.safeParse(json);
    if (!envelope.success) {
      throw new CloudflareInvalidResponseError({ detail: `${operation}: response did not match the CF API envelope` });
    }
    if (!response.ok || !envelope.data.success) {
      throw new CloudflareRequestError({
        message: `Cloudflare request failed: ${operation}.`,
        detail: `${operation}: ${errorText(envelope.data.errors)}`,
      });
    }
    return envelope.data;
  }
}

/** The most specific instance-error text, for a failure `detail`. Never the dispatched params. */
function describeError(error: WorkflowInstance["error"]): string {
  if (!error) return "no error detail";
  if (typeof error === "string") return error;
  return error.message ?? "no error detail";
}
