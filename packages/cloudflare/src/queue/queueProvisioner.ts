// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { cloudflareRequest, decodeResponse, isNotFoundError } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** A queue's identity, decoded from the Queues API's `queue_id` and `queue_name`. */
export const QueueInfo = z
  .object({
    id: z.string().describe("The CF-assigned queue id, which the REST API addresses a queue by."),
    name: z.string().describe("The queue name a producer binding names it by."),
  })
  .describe("A Cloudflare Queue's identity, as the Queues API returns it.");
export type QueueInfo = z.output<typeof QueueInfo>;

/** The Queues API's own spelling of a queue's identity, mapped onto {@link QueueInfo}. */
const QueueRecord = z
  .object({
    queue_id: z.string().describe("The CF-assigned queue id."),
    queue_name: z.string().describe("The queue name."),
  })
  .transform(({ queue_id, queue_name }) => ({ id: queue_id, name: queue_name }))
  .describe("A queue as the Queues API returns it.");

/**
 * Account-level Queues control plane: **find, create and delete queues** (#662).
 *
 * `pithy provision` creates the queue behind every `queue` binding a composition declares, and `pithy feature
 * destroy` deletes a feature's. A `queues.producers` entry names a queue, and `wrangler deploy` refuses one that
 * does not exist, so the entry is only honest because this stands the queue up. Addressed by account — unlike
 * {@link CloudflareQueueManager}, which targets one queue to send into.
 */
export class CloudflareQueueProvisioner extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare Queues (control plane)";
  }

  /** Prove access by listing queues — a read, never a create or a delete. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().queues.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }

  /** Find a queue by exact name in the account, or `null` — for idempotent provisioning. */
  async findQueueByName(name: string): Promise<QueueInfo | null> {
    return cloudflareRequest(`find queue ${name}`, async () => {
      for await (const queue of this.getClient().queues.list({ account_id: this.accountId })) {
        const parsed = QueueRecord.safeParse(queue);
        if (parsed.success && parsed.data.name === name) return parsed.data;
      }
      return null;
    });
  }

  /** Create a queue by name; returns its id and name. */
  async createQueue(name: string): Promise<QueueInfo> {
    const response = await cloudflareRequest(`create queue ${name}`, () =>
      this.getClient().queues.create({ account_id: this.accountId, queue_name: name }),
    );
    return decodeResponse(QueueRecord, response, "queue create");
  }

  /** Delete a queue by id. Idempotent — a missing queue is not an error, so teardown can re-run safely. */
  async deleteQueue(queueId: string): Promise<void> {
    await cloudflareRequest(`delete queue ${queueId}`, async () => {
      try {
        await this.getClient().queues.delete(queueId, { account_id: this.accountId });
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
    });
  }
}
