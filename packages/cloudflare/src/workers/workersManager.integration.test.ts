// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareWorkersManager } from "./workersManager";

/**
 * LIVE integration test — the Workers manager over REST. Uploads a real placeholder Worker script,
 * exercises lookup/internal-id/secret/settings paths against it, then deletes it. The script create
 * + workers.dev subdomain ordering is exactly the path the #26 secrets work found only surfaced live.
 * See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareWorkersManager — LIVE", () => {
  const workers = new CloudflareWorkersManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("creates a script, resolves it, manages a secret + settings, then deletes it", async () => {
    const name = uniqueName("pithy-int-worker");

    await withThrowawayResource(
      () => workers.createWorker(name),
      async (script) => {
        expect(script.id).toBe(name);
        expect(await workers.validateServiceAccess()).toBe(true);

        // Lookup by name, and the immutable hex internal id (the id CF Builds keys on).
        expect((await workers.getWorker(name))?.id).toBe(name);
        expect(await workers.getWorkerInternalId(name)).toMatch(/^[a-f0-9]+$/);

        // Enable the workers.dev subdomain + observability — the create→subdomain ordering from #26.
        await workers.setSubdomainSettings(name, true, false);
        await workers.updateSettings(name, { observability: { enabled: true } });

        // Secret round-trip: set, see it listed (metadata only), delete.
        await workers.addSecret(name, "TEST_SECRET", "saffron");
        expect((await workers.listSecrets(name)).some((s) => s.name === "TEST_SECRET")).toBe(true);
        await workers.deleteSecret(name, "TEST_SECRET");

        // The create produced at least one version.
        expect((await workers.listVersions(name)).length).toBeGreaterThan(0);

        // Error/absent path: an unknown script resolves to null, not a throw.
        expect(await workers.getWorker(uniqueName("pithy-int-absent"))).toBeNull();
      },
      (script) => workers.deleteWorker(script.id ?? name),
    );
  });
});
