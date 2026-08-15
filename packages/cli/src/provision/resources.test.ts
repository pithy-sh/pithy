// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { describe, expect, test, vi } from "vitest";
import { cloudflareProvisioners } from "./resources";

/**
 * `find` is find-or-create's first half, and the half that decides whether the second one runs (#378).
 *
 * A `null` from an account nothing claims is not an absence, and `provisionEnvironment` answers an
 * absence by creating — a real D1, KV namespace or R2 bucket, in whichever account the shell had named.
 * That is the one failure in this file that a re-run cannot walk back: the second run finds what the
 * first made and adopts it.
 *
 * Every account id here is a literal. Nothing below is composed from the module under test.
 */
function fakeClients() {
  const findDatabaseByName = vi.fn().mockResolvedValue(null);
  const createDatabase = vi.fn().mockResolvedValue({ uuid: "db-1" });
  const findNamespaceByTitle = vi.fn().mockResolvedValue(null);
  const createNamespace = vi.fn().mockResolvedValue({ id: "ns-1" });
  const findBucketByName = vi.fn().mockResolvedValue(null);
  const createBucket = vi.fn().mockResolvedValue({ name: "acme-prod-uploads" });
  const clients = {
    d1Provisioner: () => ({ findDatabaseByName, createDatabase, deleteDatabase: vi.fn() }),
    kvProvisioner: () => ({ findNamespaceByTitle, createNamespace, deleteNamespace: vi.fn() }),
    r2Provisioner: () => ({ findBucketByName, createBucket, deleteBucket: vi.fn() }),
  } as unknown as CloudflareClients;
  return {
    clients,
    findDatabaseByName,
    createDatabase,
    findNamespaceByTitle,
    createNamespace,
    findBucketByName,
    createBucket,
  };
}

const REFUSAL = "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.";

describe("cloudflareProvisioners on an unconfirmed account", () => {
  test("every kind's `find` refuses rather than returning the null that authorises a create", async () => {
    const { clients } = fakeClients();
    const provisioners = cloudflareProvisioners(clients, { accountId: "acct-stranger", confirmation: "ambient" });

    await expect(provisioners.d1.find("acme-prod-db")).rejects.toThrow(REFUSAL);
    await expect(provisioners.kv.find("acme-prod-sessions")).rejects.toThrow(REFUSAL);
    await expect(provisioners.r2.find("acme-prod-uploads")).rejects.toThrow(REFUSAL);
  });

  test("nothing is created, and nothing is even asked", async () => {
    const fake = fakeClients();
    const provisioners = cloudflareProvisioners(fake.clients, {
      accountId: "acct-stranger",
      confirmation: "ambient",
    });

    await provisioners.d1.find("acme-prod-db").catch(() => {});
    await provisioners.kv.find("acme-prod-sessions").catch(() => {});
    await provisioners.r2.find("acme-prod-uploads").catch(() => {});

    expect(fake.createDatabase).not.toHaveBeenCalled();
    expect(fake.createNamespace).not.toHaveBeenCalled();
    expect(fake.createBucket).not.toHaveBeenCalled();
    expect(fake.findDatabaseByName).not.toHaveBeenCalled();
    expect(fake.findNamespaceByTitle).not.toHaveBeenCalled();
    expect(fake.findBucketByName).not.toHaveBeenCalled();
  });
});

describe("cloudflareProvisioners on a confirmed account", () => {
  test("a miss is still a miss, so find-or-create still creates", async () => {
    const fake = fakeClients();
    const provisioners = cloudflareProvisioners(fake.clients, { accountId: "acct-ours", confirmation: "pinned" });

    expect(await provisioners.d1.find("acme-prod-db")).toBeNull();
    expect(await provisioners.kv.find("acme-prod-sessions")).toBeNull();
    expect(await provisioners.r2.find("acme-prod-uploads")).toBeNull();
    expect(fake.findDatabaseByName).toHaveBeenCalledWith("acme-prod-db");
  });

  test("a hit comes back as the id each kind addresses", async () => {
    const fake = fakeClients();
    fake.findDatabaseByName.mockResolvedValue({ uuid: "db-existing" });
    fake.findNamespaceByTitle.mockResolvedValue({ id: "ns-existing" });
    fake.findBucketByName.mockResolvedValue({ name: "acme-prod-uploads" });
    const provisioners = cloudflareProvisioners(fake.clients, { accountId: "acct-ours", confirmation: "named" });

    expect(await provisioners.d1.find("acme-prod-db")).toEqual({ id: "db-existing" });
    expect(await provisioners.kv.find("acme-prod-sessions")).toEqual({ id: "ns-existing" });
    expect(await provisioners.r2.find("acme-prod-uploads")).toEqual({ id: "acme-prod-uploads" });
  });
});

/**
 * The misleading tier, at the shape the five `buildResolveEnv` callers share (#378).
 *
 * `The <env> secrets database does not exist. Run pithy secrets provision first.` is a true sentence
 * about the account that was asked and a false one about the project, and an operator reading it re-runs
 * a provisioning command they have already run. The five call sites route through the same helper this
 * suite covers; what changes there is which sentence comes out.
 */
describe("a missing resource on an unconfirmed account is not a missing resource", () => {
  test("the refusal names the account rather than sending the operator to provision again", async () => {
    const fake = fakeClients();
    fake.findDatabaseByName.mockResolvedValue(null);
    const provisioners = cloudflareProvisioners(fake.clients, {
      accountId: "acct-stranger",
      confirmation: "ambient",
    });

    const refusal = await provisioners.d1.find("acme-prod-secrets").catch((error: unknown) => error);
    expect(String(refusal)).toContain("acct-stranger");
    expect(String(refusal)).not.toContain("does not exist");
  });
});
