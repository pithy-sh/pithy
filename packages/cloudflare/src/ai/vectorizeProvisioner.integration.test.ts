// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareVectorizeProvisioner, type VectorizeMetadataIndex } from "./vectorizeProvisioner";

/**
 * LIVE integration test — the Vectorize control plane. Creates a real index, reads it back, declares a
 * metadata index, then deletes both. Vectorize applies control-plane changes asynchronously, so this
 * asserts the decoded response shapes and the absent path rather than reading a freshly-created metadata
 * index back (see `vectorizeManager.integration.test.ts`). Requires Vectorize on the account (paid plan).
 * Skipped when creds are absent. Run via `bun run test:integration`.
 */
const creds = loadIntegrationCreds();
const DIMENSIONS = 32; // Vectorize requires dimensions in [32, 1536].

/**
 * Wait until a metadata property is listed on the index.
 *
 * Vectorize's metadata-index list is eventually consistent *and* non-monotonic — a live probe watched it
 * report a property, then not report it 18 seconds later with nothing else running, then report it again.
 * So a single confirming read proves nothing, and deleting straight after creating races the create: the
 * delete arrives first and Vectorize answers `400`/40005. Settle before asserting, and before deleting.
 */
async function waitForMetadataIndex(
  provisioner: CloudflareVectorizeProvisioner,
  indexName: string,
  propertyName: string,
): Promise<VectorizeMetadataIndex> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await provisioner.listMetadataIndexes(indexName);
    const found = listed.find((entry) => entry.propertyName === propertyName);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new InternalError({
    message: "A Vectorize metadata index never became visible.",
    action: "Re-run the suite. If it repeats, check Vectorize's status — the control plane may be degraded.",
    detail: `metadata index ${indexName}.${propertyName} never appeared after 30 polls at 2s`,
  });
}

describe.skipIf(!creds.hasCreds)("CloudflareVectorizeProvisioner — LIVE", () => {
  // Teardown only runs while the process lives. A run killed by a timeout or a Ctrl-C orphans its index —
  // which is how two of them once sat on a real account for a month, and how `pithy-int-vecprov-…` came
  // back. The reclaim is now the run's own `globalSetup` sweep rather than a `beforeAll` here, so it also
  // covers `@pithy-sh/vector`'s indexes, which this suite never saw. See `test-utils/reap.ts`.

  test("validates access, creates an index, finds it, indexes a metadata property, then deletes it", async () => {
    const provisioner = new CloudflareVectorizeProvisioner({ accountId: creds.accountId, apiToken: creds.apiToken });

    expect(await provisioner.validateServiceAccess()).toBe(true);

    const name = uniqueName("vecprov");
    await withThrowawayResource(
      () => provisioner.createIndex(name, { dimensions: DIMENSIONS, metric: "cosine" }),
      async (index) => {
        expect(index.name).toBe(name);
        expect(index.config).toEqual({ dimensions: DIMENSIONS, metric: "cosine" });

        // The index is addressable by name, and appears in the account list.
        expect(await provisioner.findIndexByName(name)).toEqual(index);
        expect((await provisioner.listIndexes()).some((entry) => entry.name === name)).toBe(true);

        // Create, then settle before deleting — the delete would otherwise race the create and hit the
        // `400`/40005 absence path, which is precisely what used to fail this test.
        await provisioner.createMetadataIndex(name, "tenantId", "string");

        // Assert on the observation that settled, never on a fresh read. Because the list is
        // non-monotonic, re-listing here would flap back to empty often enough to fail under load — it
        // did, which is how this comment came to be written.
        const found = await waitForMetadataIndex(provisioner, name, "tenantId");

        // The decoded shape carries the type in the lowercase spelling the create endpoint takes — live
        // returns "String", so this also pins the casing normalization.
        expect(found).toEqual({ propertyName: "tenantId", indexType: "string" });

        await provisioner.deleteMetadataIndex(name, "tenantId");

        // Idempotent by contract: a second delete of the same property is a no-op, not a 400.
        await expect(provisioner.deleteMetadataIndex(name, "tenantId")).resolves.toBeUndefined();

        // Absent path: a name nobody created reads as null, not a throw.
        expect(await provisioner.findIndexByName(uniqueName("absent"))).toBeNull();
      },
      (index) => provisioner.deleteIndex(index.name),
    );

    // Teardown is idempotent — a second delete of the same index is a no-op.
    await expect(provisioner.deleteIndex(name)).resolves.toBeUndefined();
  });
});
