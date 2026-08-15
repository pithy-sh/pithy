// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { TestersConfig } from "@pithy-sh/testers/src/config/config";
import { testersWorkerName } from "@pithy-sh/testers/src/provision/provisionTesters";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { CloudflareTestersProvisioner } from "./testersProvisioner";

/** The project every provisioned name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "acme";

/**
 * The live provisioner's Cloudflare-facing behaviour.
 *
 * `provisionTesters.test.ts` in the capability covers the *orchestration* — order, fan-out, what runs
 * before what — against a fake seam. This covers the seam's own implementation, which that fake by
 * definition cannot: its `deleteWorker` never throws, so a teardown that is documented as idempotent
 * and is not would pass there. It did. That is what these tests are for.
 *
 * `deployWorker` is not exercised: it shells out to wrangler and writes a file, and the config it
 * builds is already covered by `resolveTestersConfig`'s own tests against the committed template.
 */

/** A fake CloudflareClients exposing only what the provisioner touches, with spies. */
function fakeCf() {
  const getWorker = vi.fn();
  const deleteWorker = vi.fn();
  const accountSubdomain = vi.fn();
  const cf = {
    workers: () => ({ getWorker, deleteWorker, accountSubdomain }),
  } as unknown as CloudflareClients;
  return { cf, getWorker, deleteWorker, accountSubdomain };
}

function provisioner(cf: CloudflareClients, events: CliAuditEvent[] = []) {
  return new CloudflareTestersProvisioner({
    project: PROJECT,
    cf,
    account: { accountId: "acct-1", confirmation: "pinned" },
    apiToken: "token",
    testersConfig: TestersConfig.parse({ baseUrl: "https://api.example.test" }),
    email: undefined,
    resolveEnv: async () => ({ appDatabaseId: "app-db", suppressionDatabaseId: "sup-db" }),
    audit: async (event) => void events.push(event),
  });
}

describe("preflight", () => {
  test("passes when the account has a workers.dev subdomain", async () => {
    const { cf, accountSubdomain } = fakeCf();
    accountSubdomain.mockResolvedValue("acme");
    await expect(provisioner(cf).preflight()).resolves.toBeUndefined();
  });

  test("refuses without one, naming the one click that fixes it", async () => {
    // Workflows cannot deploy to an account that has never registered a subdomain, and the raw
    // Cloudflare error for it names neither the cause nor the fix.
    const { cf, accountSubdomain } = fakeCf();
    accountSubdomain.mockResolvedValue(null);
    await expect(provisioner(cf).preflight()).rejects.toThrow(/workers\.dev subdomain/);
  });
});

describe("deleteWorker is idempotent", () => {
  test("deletes the host when it is deployed, and audits it as a warning", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    const events: CliAuditEvent[] = [];
    getWorker.mockResolvedValue({ id: testersWorkerName(PROJECT, "staging") });

    await provisioner(cf, events).deleteWorker("staging");

    expect(deleteWorker).toHaveBeenCalledWith(testersWorkerName(PROJECT, "staging"));
    expect(events.map((event) => event.action)).toEqual(["testers/worker_deleted"]);
    expect(events[0]?.severity).toBe("warning");
    // The environment is the row's own column now, not a key inside the opaque metadata bag.
    expect(events[0]?.environment).toBe("staging");
  });

  test("does nothing when it is already gone", async () => {
    // Cloudflare answers a delete for an absent script with a 404, and `cloudflareRequest` rethrows
    // that rather than swallowing it. Since `deprovisionTesters` loops the environments with no
    // per-environment catch, an un-provisioned staging would abort before production was attempted —
    // so a teardown documented as safe to re-run would fail on the second run.
    const { cf, getWorker, deleteWorker } = fakeCf();
    const events: CliAuditEvent[] = [];
    getWorker.mockResolvedValue(null);

    await expect(provisioner(cf, events).deleteWorker("staging")).resolves.toBeUndefined();
    expect(deleteWorker).not.toHaveBeenCalled();
  });

  test("and records nothing, because a deletion that did not happen is not a deletion", async () => {
    // The audit trail is the record of what actually happened. An event for a worker that never
    // existed is a false entry in the one log meant to be trustworthy.
    const { cf, getWorker } = fakeCf();
    const events: CliAuditEvent[] = [];
    getWorker.mockResolvedValue(null);

    await provisioner(cf, events).deleteWorker("prod");
    expect(events).toEqual([]);
  });

  test("re-running after a real delete is still a no-op", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValueOnce({ id: testersWorkerName(PROJECT, "prod") }).mockResolvedValue(null);

    const testers = provisioner(cf);
    await testers.deleteWorker("prod");
    await testers.deleteWorker("prod");

    expect(deleteWorker).toHaveBeenCalledTimes(1);
  });
});

describe("the audit is optional", () => {
  test("a provisioner built without one still deletes", async () => {
    // The CLI wires an emitter, but `audit` is optional on the options and the default must not be a
    // crash on the teardown path.
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue({ id: testersWorkerName(PROJECT, "staging") });

    const bare = new CloudflareTestersProvisioner({
      project: PROJECT,
      cf,
      account: { accountId: "acct-1", confirmation: "pinned" },
      apiToken: "token",
      testersConfig: TestersConfig.parse({ baseUrl: "https://api.example.test" }),
      email: undefined,
      resolveEnv: async () => ({ appDatabaseId: "app-db", suppressionDatabaseId: "sup-db" }),
    });

    await expect(bare.deleteWorker("staging")).resolves.toBeUndefined();
    expect(deleteWorker).toHaveBeenCalledTimes(1);
  });
});

/**
 * The account a teardown deletes from must be one something claims (#378).
 *
 * `getWorker` answers "this account has no such script" and "you asked an account that is not yours"
 * with the same `null`, so a teardown pointed at a stranger's account used to delete nothing, audit
 * nothing, and exit 0 — a success message printed over a production Worker that is still running.
 *
 * The account id below is a literal, written here and nowhere else, and the plant that proves this gate
 * can fail is one word: turn `confirmation` back into something the guard ignores.
 */
describe("teardown refuses an unconfirmed account", () => {
  test("refuses instead of reading a miss as `already gone`", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue(null);
    const stranger = new CloudflareTestersProvisioner({
      project: PROJECT,
      cf,
      account: { accountId: "acct-stranger", confirmation: "ambient" },
      apiToken: "token",
      testersConfig: TestersConfig.parse({ baseUrl: "https://api.example.test" }),
      email: undefined,
      resolveEnv: async () => ({ appDatabaseId: "app-db", suppressionDatabaseId: "sup-db" }),
    });

    await expect(stranger.deleteWorker("prod")).rejects.toThrow(
      "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.",
    );
    expect(deleteWorker).not.toHaveBeenCalled();
  });

  test("does not even ask — an answer it could not believe is not worth the round trip", async () => {
    const { cf, getWorker } = fakeCf();
    const stranger = new CloudflareTestersProvisioner({
      project: PROJECT,
      cf,
      account: { accountId: "acct-stranger", confirmation: "ambient" },
      apiToken: "token",
      testersConfig: TestersConfig.parse({ baseUrl: "https://api.example.test" }),
      email: undefined,
      resolveEnv: async () => ({ appDatabaseId: "app-db", suppressionDatabaseId: "sup-db" }),
    });

    await stranger.deleteWorker("prod").catch(() => {});
    expect(getWorker).not.toHaveBeenCalled();
  });

  test("audits nothing, because a refusal is not a deletion", async () => {
    const { cf, getWorker } = fakeCf();
    getWorker.mockResolvedValue(null);
    const events: CliAuditEvent[] = [];
    const stranger = new CloudflareTestersProvisioner({
      project: PROJECT,
      cf,
      account: { accountId: "acct-stranger", confirmation: "ambient" },
      apiToken: "token",
      testersConfig: TestersConfig.parse({ baseUrl: "https://api.example.test" }),
      email: undefined,
      resolveEnv: async () => ({ appDatabaseId: "app-db", suppressionDatabaseId: "sup-db" }),
      audit: async (event) => void events.push(event),
    });

    await stranger.deleteWorker("prod").catch(() => {});
    expect(events).toEqual([]);
  });

  test("a confirmed account still tears down — the guard refuses one thing and not everything", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue({ id: testersWorkerName(PROJECT, "prod") });
    await provisioner(cf).deleteWorker("prod");
    expect(deleteWorker).toHaveBeenCalledWith(testersWorkerName(PROJECT, "prod"));
  });
});
