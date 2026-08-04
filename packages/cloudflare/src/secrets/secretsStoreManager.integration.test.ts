// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withNamedResource } from "../test-utils/harness";
import { CloudflareSecretsStoreManager } from "./secretsStoreManager";

/**
 * LIVE integration test — the account-level Secrets Store over REST. Reuses the store in creds
 * (`SECRETS_STORE_ID`); the throwaway resource is a single uniquely-named secret, deleted in the
 * guaranteed teardown so the shared store is never left with test residue. Skipped without a store
 * id. See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();
const hasStore = creds.hasCreds && Boolean(creds.secretsStoreId);

describe.skipIf(!hasStore)("CloudflareSecretsStoreManager — LIVE", () => {
  const manager = new CloudflareSecretsStoreManager({
    accountId: creds.accountId,
    apiToken: creds.apiToken,
    storeId: creds.secretsStoreId,
  });

  test("creates, updates, lists, and deletes a secret; reports a missing delete", async () => {
    const name = uniqueName("secret");

    // `withNamedResource`, because `putSecret` is a write at a name this test already chose. Under
    // `withThrowawayResource` a create that rejects skips teardown entirely — correct when the id only
    // exists on success, and wrong here: the store may have accepted the write and failed on the way
    // back, leaving an entry whose name is right there in scope. Eight such entries sat on a real
    // account with no reaper for the kind.
    await withNamedResource(
      name,
      async (secretName) => {
        await manager.putSecret(secretName, "first-value");
      },
      async (secretName) => {
        // Happy path: the secret exists and decodes in the listing (metadata only, never plaintext).
        expect(await manager.validateServiceAccess()).toBe(true);
        expect(await manager.exists(secretName)).toBe(true);

        const listed = (await manager.listSecrets()).find((entry) => entry.name === secretName);
        expect(listed?.name).toBe(secretName);
        expect(listed?.created).toBeInstanceOf(Date); // JsonDate codec decoded the wire ISO string

        // Update path: put again replaces the value (delete + create) without leaving it absent.
        await manager.putSecret(secretName, "second-value");
        expect(await manager.exists(secretName)).toBe(true);

        // Error path: deleting an unknown secret is a typed not-found.
        await expect(manager.deleteSecret(uniqueName("absent"))).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "core/not_found" }) }),
        );
      },
      async (secretName) => {
        // Idempotent: teardown now also runs when the create rejected, where the entry may never have
        // existed, and the run's `globalSetup` sweep may have reached it first.
        await manager.deleteSecretIfPresent(secretName);
      },
    );

    // Teardown really removed it.
    expect(await manager.exists(name)).toBe(false);
  });
});
