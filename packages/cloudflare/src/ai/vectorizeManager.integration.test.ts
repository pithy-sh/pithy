import { Cloudflare } from "cloudflare";
import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareVectorizeManager } from "./vectorizeManager";

/**
 * LIVE integration test — Vectorize over REST. Creates a real index with the raw SDK (the manager
 * addresses an existing index by name), exercises describe/insert/query, then deletes the index.
 * Vectorize mutations are async (eventually consistent), so this asserts the decoded response shapes
 * and a dimension-mismatch error path rather than reading freshly-written vectors back. Requires
 * Vectorize on the account (paid plan). See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();
const DIMENSIONS = 32; // Vectorize requires dimensions in [32, 1536].
const vectorOf = (seed: number): number[] => Array.from({ length: DIMENSIONS }, (_, i) => (i + seed) / 100);

describe.skipIf(!creds.hasCreds)("CloudflareVectorizeManager — LIVE", () => {
  const client = new Cloudflare({ apiToken: creds.apiToken });

  test("creates an index, describes it, inserts + queries, then deletes the index", async () => {
    await withThrowawayResource(
      () =>
        client.vectorize.indexes.create({
          account_id: creds.accountId,
          name: uniqueName("pithy-int-vec"),
          config: { dimensions: DIMENSIONS, metric: "cosine" },
        }),
      async (index) => {
        const vectorize = new CloudflareVectorizeManager({
          accountId: creds.accountId,
          apiToken: creds.apiToken,
          indexName: index?.name ?? "",
        });

        // Happy path: the index is reachable, and describe decodes to the configured dimensions.
        expect(await vectorize.validateServiceAccess()).toBe(true);
        expect((await vectorize.describe())?.dimensions).toBe(DIMENSIONS);

        // Insert returns a mutation id (the change is enqueued, processed asynchronously).
        const inserted = await vectorize.insert([{ id: "v1", values: vectorOf(0), metadata: { tag: "a" } }]);
        expect(inserted).not.toBeNull();

        // Query with a matching-dimension vector decodes to a { count, matches } result (empty until
        // the async insert is processed — we assert the decoded shape, not freshly-written matches).
        const result = await vectorize.query(vectorOf(0), { topK: 1 });
        expect(Array.isArray(result?.matches)).toBe(true);

        // Error path: a wrong-dimension query vector is rejected by the API.
        await expect(vectorize.query([0.1, 0.2])).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
        );
      },
      async (index) => {
        if (index?.name) await client.vectorize.indexes.delete(index.name, { account_id: creds.accountId });
      },
    );
  });
});
