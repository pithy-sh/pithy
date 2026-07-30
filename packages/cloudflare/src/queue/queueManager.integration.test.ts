// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Cloudflare } from "cloudflare";
import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareQueueManager } from "./queueManager";

/**
 * LIVE integration test — the Queues producer over REST. Creates a real queue with the raw SDK
 * (the manager addresses an existing queue by name), pushes messages through the manager, then
 * deletes the queue. See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareQueueManager — LIVE", () => {
  const client = new Cloudflare({ apiToken: creds.apiToken });

  test("resolves the queue id, sends single + batch messages, then surfaces an unknown queue", async () => {
    await withThrowawayResource(
      () => client.queues.create({ account_id: creds.accountId, queue_name: uniqueName("pithy-int-queue") }),
      async (queue) => {
        const manager = new CloudflareQueueManager({
          accountId: creds.accountId,
          apiToken: creds.apiToken,
          queueName: queue.queue_name ?? "",
        });

        // Happy path: name → id resolution, and the id is cached.
        const id = await manager.getQueueId();
        expect(id).toBeTruthy();
        expect(await manager.getQueueId()).toBe(id);

        // Push a single message and a batch. A failed push throws, so resolving is the assertion;
        // the response itself now carries only best-effort queue metrics.
        await manager.send({ type: "welcome", to: "saffron" });
        const batch = await manager.sendBatch([{ n: 1 }, { n: 2 }, { n: 3 }]);
        expect(batch).toBeDefined();

        // Error path: an unknown queue name resolves to a typed not-found, not a raw throw.
        const missing = new CloudflareQueueManager({
          accountId: creds.accountId,
          apiToken: creds.apiToken,
          queueName: uniqueName("pithy-int-missing"),
        });
        await expect(missing.send({ x: 1 })).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "core/not_found" }) }),
        );
      },
      async (queue) => {
        if (queue.queue_id) await client.queues.delete(queue.queue_id, { account_id: creds.accountId });
      },
    );
  });
});
