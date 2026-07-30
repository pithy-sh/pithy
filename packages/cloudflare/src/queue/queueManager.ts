// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageBulkPushResponse } from "cloudflare/resources/queues/messages";
import { CloudflareNotConfiguredError, cloudflareRequest, reasonOf } from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";

/** Config for the Queue manager: the shared client config plus the queue it targets by name. */
export interface QueueManagerConfig extends CloudflareManagerConfig {
  /**
   * The queue name. The REST API addresses queues by id, so the manager resolves this name to an
   * id once (and caches it). Required for every operation.
   */
  queueName: string;
}

/** The per-batch outcome of a `sendBatches` run: a partial-failure report, never a thrown batch. */
export interface QueueBatchResult {
  /** The caller-supplied number identifying this batch. */
  batchNumber: number;
  /** Whether the batch was sent. */
  success: boolean;
  /** The failure reason, present only when `success` is false. */
  error?: string;
  /** How many messages the batch carried. */
  messageCount: number;
}

/** The aggregate result of a `sendBatches` run. */
export interface SendBatchesResult {
  /** How many batches sent successfully. */
  successCount: number;
  /** How many batches failed. */
  failureCount: number;
  /** The per-batch outcomes, in input order (truncated if a non-continuing run stopped early). */
  results: QueueBatchResult[];
}

/** One batch of messages to send, with bookkeeping for progress reporting. */
export interface QueueBatch<T> {
  /** A number identifying this batch in callbacks and results. */
  batchNumber: number;
  /** How many messages the batch carries (for progress reporting; need not equal `messages.length`). */
  messageCount: number;
  /** The message bodies to enqueue. */
  messages: T[];
}

/** Options governing a `sendBatches` run. Callbacks are pure reporting hooks — no I/O is built in. */
export interface SendBatchesOptions {
  /** Called before each batch is sent. */
  onProgress?: (batchNumber: number, totalBatches: number, messageCount: number) => void;
  /** Called after a batch sends successfully. */
  onSuccess?: (batchNumber: number, messageCount: number) => void;
  /** Called when a batch fails. */
  onError?: (batchNumber: number, error: string) => void;
  /** Milliseconds to wait between batches. Defaults to 0 (no delay). */
  delayBetweenBatches?: number;
  /** Keep going after a batch fails (collecting results). When false, the first failure throws. */
  continueOnError?: boolean;
}

/**
 * Out-of-Worker Cloudflare Queues access over the REST API: resolve a queue by name and bulk-push
 * messages from a CLI/CI/provisioning context. Inside a Worker you use the `Queue` binding directly
 * — this manager is the REST counterpart, addressed by queue id (resolved from the name).
 */
export class CloudflareQueueManager extends CloudflareManager {
  private readonly queueName: string;

  private queueId?: string;

  constructor(config: QueueManagerConfig) {
    super(config);
    if (!config.queueName) {
      throw new CloudflareNotConfiguredError({ detail: "Missing queueName for Queue REST access." });
    }
    this.queueName = config.queueName;
  }

  /** Resolve (and cache) the queue id for the configured name by listing the account's queues. */
  async getQueueId(): Promise<string> {
    if (this.queueId) return this.queueId;

    const queues = await cloudflareRequest("list queues", async () => {
      const response = await this.getClient().queues.list({ account_id: this.accountId });
      return response.result;
    });

    const match = queues.find((queue) => queue.queue_name === this.queueName);
    if (!match?.queue_id) {
      const available = queues.map((queue) => queue.queue_name).join(", ");
      throw new NotFoundError({
        message: `Queue '${this.queueName}' not found.`,
        detail: `Available queues: ${available || "(none)"}.`,
        action: "Verify the queue name and that the API token has Queues access.",
      });
    }

    this.queueId = match.queue_id;
    return this.queueId;
  }

  /** Bulk-push a batch of message bodies to the queue. Each item becomes one queue message. */
  async sendBatch<T>(messages: T[]): Promise<MessageBulkPushResponse> {
    const queueId = await this.getQueueId();
    return cloudflareRequest(`send batch of ${messages.length} message(s)`, async () => {
      // The SDK unwraps the API envelope and throws an `APIError` when `success` is false, so a
      // resolved response is already a success — `cloudflareRequest` converts any throw for us.
      return await this.getClient().queues.messages.bulkPush(queueId, {
        account_id: this.accountId,
        messages: messages.map((body) => ({ body: body as unknown })),
      });
    });
  }

  /** Send a single message. Convenience wrapper over `sendBatch`. */
  async send<T>(message: T): Promise<void> {
    await this.sendBatch([message]);
  }

  /**
   * Send many batches in sequence, collecting a per-batch result. By default it continues past a
   * failed batch (reporting it) rather than aborting; set `continueOnError: false` to throw on the
   * first failure. Optional callbacks are pure reporting hooks; nothing is logged or prompted.
   */
  async sendBatches<T>(batches: QueueBatch<T>[], options: SendBatchesOptions = {}): Promise<SendBatchesResult> {
    const { onProgress, onSuccess, onError, delayBetweenBatches = 0, continueOnError = true } = options;

    // Resolve the queue id once so a misconfigured queue fails before any batch is attempted.
    await this.getQueueId();

    let successCount = 0;
    let failureCount = 0;
    const results: QueueBatchResult[] = [];

    for (const batch of batches) {
      onProgress?.(batch.batchNumber, batches.length, batch.messageCount);
      try {
        await this.sendBatch(batch.messages);
        onSuccess?.(batch.batchNumber, batch.messageCount);
        successCount++;
        results.push({ batchNumber: batch.batchNumber, success: true, messageCount: batch.messageCount });
      } catch (error) {
        const reason = reasonOf(error);
        onError?.(batch.batchNumber, reason);
        failureCount++;
        results.push({
          batchNumber: batch.batchNumber,
          success: false,
          error: reason,
          messageCount: batch.messageCount,
        });
        if (!continueOnError) throw error;
      }

      const isLast = batch === batches[batches.length - 1];
      if (!isLast && delayBetweenBatches > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }

    return { successCount, failureCount, results };
  }

  /** The queue this manager targets, the account it lives in, and the resolved id (once known). */
  getQueueInfo(): { queueName: string; accountId: string; queueId?: string } {
    return { queueName: this.queueName, accountId: this.accountId, queueId: this.queueId };
  }

  getServiceType(): string {
    return "Queues";
  }

  /** Prove access by listing the account's queues. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().queues.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }
}
