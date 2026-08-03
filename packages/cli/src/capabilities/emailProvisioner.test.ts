// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { emailWorkerName, suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import type { EmailTheme } from "@pithy-sh/email/src/templates/theme";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { CloudflareEmailDeprovisioner, CloudflareEmailProvisioner } from "./emailProvisioner";

/** The project every provisioned name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "acme";

/** A fake CloudflareClients exposing only the methods the (de)provisioner touches, with spies. */
function fakeCf() {
  const findDatabaseByName = vi.fn();
  const createDatabase = vi.fn();
  const deleteDatabase = vi.fn();
  const getWorker = vi.fn();
  const deleteWorker = vi.fn();
  const ensureWorkerRoute = vi.fn();
  const cf = {
    d1Provisioner: () => ({ findDatabaseByName, createDatabase, deleteDatabase }),
    workers: () => ({ getWorker, deleteWorker }),
    emailRouting: () => ({ ensureWorkerRoute }),
  } as unknown as CloudflareClients;
  return { cf, findDatabaseByName, createDatabase, deleteDatabase, getWorker, deleteWorker, ensureWorkerRoute };
}

/** A stand-in theme — these tests never touch `deployWorker`, the only method that reads it. */
const fakeTheme = {} as EmailTheme;

describe("CloudflareEmailProvisioner", () => {
  test("ensureSuppressionDatabase audits a create, and records nothing when it reuses the database", async () => {
    const { cf, findDatabaseByName, createDatabase } = fakeCf();
    const events: CliAuditEvent[] = [];
    const provisioner = new CloudflareEmailProvisioner({
      project: PROJECT,
      cf,
      accountId: "acct-1",
      apiToken: "tok",
      storeId: "store-1",
      theme: fakeTheme,
      resolveEnv: async () => {
        throw new Error("not used by these tests");
      },
      audit: async (event) => void events.push(event),
    });

    findDatabaseByName.mockResolvedValue(null);
    createDatabase.mockResolvedValue({ uuid: "new-db", name: suppressionDatabaseName(PROJECT) });
    expect(await provisioner.ensureSuppressionDatabase()).toEqual({ databaseId: "new-db" });
    expect(events).toEqual([
      expect.objectContaining({
        action: "email/suppression_db_created",
        outcome: "success",
        severity: "info",
        resourceType: "cf_d1",
        resourceId: "new-db",
        // D1 exposes no tags, so the audit trail is still the only place a human can later read which
        // project this database belongs to — but that now lives in the row's own `project` column,
        // stamped by the recorder, rather than in a metadata key only this emitter remembered to set.
        metadata: { name: suppressionDatabaseName(PROJECT) },
      }),
    ]);

    events.length = 0;
    createDatabase.mockClear();
    findDatabaseByName.mockResolvedValue({ uuid: "existing-db", name: suppressionDatabaseName(PROJECT) });
    expect(await provisioner.ensureSuppressionDatabase()).toEqual({ databaseId: "existing-db" });
    expect(createDatabase).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test("ensureRoutingRule audits a create only when the rule is newly created", async () => {
    const { cf, ensureWorkerRoute } = fakeCf();
    const events: CliAuditEvent[] = [];
    const provisioner = new CloudflareEmailProvisioner({
      project: PROJECT,
      cf,
      accountId: "acct-1",
      apiToken: "tok",
      storeId: "store-1",
      theme: fakeTheme,
      resolveEnv: async () => {
        throw new Error("not used by these tests");
      },
      routing: { zoneId: "zone-1", address: "bounce@example.com", appWorkerName: "pithy-app-prod" },
      audit: async (event) => void events.push(event),
    });

    ensureWorkerRoute.mockResolvedValue({ created: true });
    await provisioner.ensureRoutingRule();
    expect(events).toEqual([
      expect.objectContaining({
        action: "email/routing_rule_created",
        outcome: "success",
        severity: "info",
        resourceType: "cf_email_routing_rule",
        resourceId: "bounce@example.com",
      }),
    ]);

    events.length = 0;
    ensureWorkerRoute.mockResolvedValue({ created: false });
    await provisioner.ensureRoutingRule();
    expect(events).toEqual([]);
  });

  test("ensureRoutingRule records nothing when routing isn't configured", async () => {
    const { cf, ensureWorkerRoute } = fakeCf();
    const events: CliAuditEvent[] = [];
    const provisioner = new CloudflareEmailProvisioner({
      project: PROJECT,
      cf,
      accountId: "acct-1",
      apiToken: "tok",
      storeId: "store-1",
      theme: fakeTheme,
      resolveEnv: async () => {
        throw new Error("not used by these tests");
      },
      audit: async (event) => void events.push(event),
    });

    expect(await provisioner.ensureRoutingRule()).toEqual({ created: false, skipped: true });
    expect(ensureWorkerRoute).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("CloudflareEmailDeprovisioner", () => {
  test("deleteWorker audits a warning-severity removal only when a worker was actually deployed", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    const events: CliAuditEvent[] = [];
    const deprovisioner = new CloudflareEmailDeprovisioner({
      cf,
      project: PROJECT,
      audit: async (event) => void events.push(event),
    });

    getWorker.mockResolvedValue({ id: emailWorkerName(PROJECT, "staging") });
    await deprovisioner.deleteWorker("staging");
    expect(deleteWorker).toHaveBeenCalledWith(emailWorkerName(PROJECT, "staging"));
    expect(events).toEqual([
      expect.objectContaining({
        action: "email/worker_removed",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_worker",
        resourceId: emailWorkerName(PROJECT, "staging"),
      }),
    ]);

    events.length = 0;
    getWorker.mockResolvedValue(null);
    await deprovisioner.deleteWorker("prod");
    expect(events).toEqual([]);
  });

  test("deleteSuppressionDatabase audits a warning-severity removal only when the database existed", async () => {
    const { cf, findDatabaseByName, deleteDatabase } = fakeCf();
    const events: CliAuditEvent[] = [];
    const deprovisioner = new CloudflareEmailDeprovisioner({
      cf,
      project: PROJECT,
      audit: async (event) => void events.push(event),
    });

    findDatabaseByName.mockResolvedValue({ uuid: "db-1", name: suppressionDatabaseName(PROJECT) });
    await deprovisioner.deleteSuppressionDatabase();
    expect(deleteDatabase).toHaveBeenCalledWith("db-1");
    expect(events).toEqual([
      expect.objectContaining({
        action: "email/suppression_db_removed",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_d1",
        resourceId: "db-1",
      }),
    ]);

    events.length = 0;
    findDatabaseByName.mockResolvedValue(null);
    await deprovisioner.deleteSuppressionDatabase();
    expect(events).toEqual([]);
  });
});
