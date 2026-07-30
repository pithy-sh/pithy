// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareWorkersManager } from "./workersManager";
import { WorkersProvisioner } from "./workersProvisioner";

/**
 * LIVE integration test — the Workers provisioner orchestration (create + subdomain + observability
 * in one step, secrets, and the queue-subscription guard). The git-repo build trigger and zone route
 * paths need external fixtures (a connected repo, a zone) and are out of scope here — tracked under
 * #39's follow-ups. See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("WorkersProvisioner — LIVE", () => {
  const provisioner = new WorkersProvisioner({ accountId: creds.accountId, apiToken: creds.apiToken });
  // The provisioner has no teardown of its own; delete the script with the manager.
  const workers = new CloudflareWorkersManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("provisions a worker (create + subdomain + observability), sets a secret, guards a missing queue", async () => {
    const name = uniqueName("pithy-int-prov");

    await withThrowawayResource(
      () => provisioner.createWorker(name),
      async (scriptId) => {
        // Happy path: the orchestrated create returns the script id and enables subdomain + observability.
        expect(scriptId).toBeTruthy();
        expect(await provisioner.getWorkerInternalId(name)).toMatch(/^[a-f0-9]+$/);

        await provisioner.addWorkerSecret(name, "API_KEY", "saffron");
        expect((await workers.listSecrets(name)).some((s) => s.name === "API_KEY")).toBe(true);

        // Error path: subscribing build events to a non-existent queue is a typed not_configured.
        await expect(
          provisioner.setupBuildEventSubscription(name, uniqueName("pithy-int-missing-queue")),
        ).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
        );
      },
      () => workers.deleteWorker(name),
    );
  });
});
