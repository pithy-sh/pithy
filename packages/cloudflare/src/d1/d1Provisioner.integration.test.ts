// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareD1Provisioner } from "./d1Provisioner";

/**
 * LIVE integration test — creates and deletes a real D1 database to exercise the control-plane
 * client against the account. Uses the shared harness (creds, naming, guaranteed teardown); see
 * `README.md` § "Live integration tests" and `kvManager.integration.test.ts` for the template.
 * Skipped when creds are absent. Run via `bun run test:integration`.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareD1Provisioner — LIVE", () => {
  test("validates access, creates a database, then deletes it", async () => {
    const provisioner = new CloudflareD1Provisioner({ accountId: creds.accountId, apiToken: creds.apiToken });

    expect(await provisioner.validateServiceAccess()).toBe(true);

    const name = uniqueName("d1");
    await withThrowawayResource(
      () => provisioner.createDatabase(name),
      async (db) => {
        expect(db.uuid).toBeTruthy();
        expect(db.name).toBe(name);
      },
      (db) => provisioner.deleteDatabase(db.uuid),
    );
  });
});
