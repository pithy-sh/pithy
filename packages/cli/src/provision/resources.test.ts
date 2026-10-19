// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { cloudflareFeatureRepos, cloudflareProvisioners, cloudflareWorkerScripts } from "./resources";

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
  const findQueueByName = vi.fn().mockResolvedValue(null);
  const createQueue = vi.fn().mockResolvedValue({ id: "q-1", name: "acme-prod-jobs" });
  const clients = {
    d1Provisioner: () => ({ findDatabaseByName, createDatabase, deleteDatabase: vi.fn() }),
    kvProvisioner: () => ({ findNamespaceByTitle, createNamespace, deleteNamespace: vi.fn() }),
    r2Provisioner: () => ({ findBucketByName, createBucket, deleteBucket: vi.fn() }),
    queueProvisioner: () => ({ findQueueByName, createQueue, deleteQueue: vi.fn() }),
  } as unknown as CloudflareClients;
  return {
    clients,
    findDatabaseByName,
    createDatabase,
    findNamespaceByTitle,
    createNamespace,
    findBucketByName,
    createBucket,
    findQueueByName,
    createQueue,
  };
}

const REFUSAL = "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.";

describe("cloudflareProvisioners on an unconfirmed account", () => {
  test("every kind's `find` refuses rather than returning the null that authorizes a create", async () => {
    const { clients } = fakeClients();
    const provisioners = cloudflareProvisioners(clients, { accountId: "acct-stranger", confirmation: "ambient" });

    await expect(provisioners.d1.find("acme-prod-db")).rejects.toThrow(REFUSAL);
    await expect(provisioners.kv.find("acme-prod-sessions")).rejects.toThrow(REFUSAL);
    await expect(provisioners.r2.find("acme-prod-uploads")).rejects.toThrow(REFUSAL);
    await expect(provisioners.queue.find("acme-prod-jobs")).rejects.toThrow(REFUSAL);
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
    await provisioners.queue.find("acme-prod-jobs").catch(() => {});

    expect(fake.createDatabase).not.toHaveBeenCalled();
    expect(fake.createQueue).not.toHaveBeenCalled();
    expect(fake.findQueueByName).not.toHaveBeenCalled();
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
    expect(await provisioners.queue.find("acme-prod-jobs")).toBeNull();
    expect(fake.findDatabaseByName).toHaveBeenCalledWith("acme-prod-db");
    expect(fake.findQueueByName).toHaveBeenCalledWith("acme-prod-jobs");
  });

  test("a hit comes back as the id each kind addresses", async () => {
    const fake = fakeClients();
    fake.findDatabaseByName.mockResolvedValue({ uuid: "db-existing" });
    fake.findNamespaceByTitle.mockResolvedValue({ id: "ns-existing" });
    fake.findBucketByName.mockResolvedValue({ name: "acme-prod-uploads" });
    fake.findQueueByName.mockResolvedValue({ id: "q-existing", name: "acme-prod-jobs" });
    const provisioners = cloudflareProvisioners(fake.clients, { accountId: "acct-ours", confirmation: "named" });

    expect(await provisioners.d1.find("acme-prod-db")).toEqual({ id: "db-existing" });
    expect(await provisioners.kv.find("acme-prod-sessions")).toEqual({ id: "ns-existing" });
    expect(await provisioners.r2.find("acme-prod-uploads")).toEqual({ id: "acme-prod-uploads" });
    // A queue is deleted by its CF-assigned id, so the id is what a find hands back (#662).
    expect(await provisioners.queue.find("acme-prod-jobs")).toEqual({ id: "q-existing" });
    expect(await provisioners.queue.create("acme-prod-jobs")).toEqual({ id: "q-1" });
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

/**
 * **A feature's Worker scripts, confirmed before they are deleted (#592).**
 *
 * `destroy` deletes a script by name, and Cloudflare's script listing answers an account nothing claims
 * with the same empty array it answers a real absence with. So `exists` refuses on an unconfirmed
 * account rather than answering, and a delete is never attempted there: a script of that name in some
 * other account is somebody's deployment.
 */
describe("cloudflareWorkerScripts", () => {
  function fakeWorkers(deployed: string[]) {
    const getWorker = vi.fn(async (name: string) => (deployed.includes(name) ? { id: name } : null));
    const deleteWorker = vi.fn(async () => {});
    const clients = { workers: () => ({ getWorker, deleteWorker }) } as unknown as CloudflareClients;
    return { clients, getWorker, deleteWorker };
  }

  test("on an unconfirmed account it refuses, and asks nothing", async () => {
    const fake = fakeWorkers(["acme-f69-demo--api"]);
    const scripts = cloudflareWorkerScripts(fake.clients, { accountId: "acct-stranger", confirmation: "ambient" });

    await expect(scripts.exists("acme-f69-demo--api")).rejects.toThrow(REFUSAL);
    expect(fake.getWorker).not.toHaveBeenCalled();
    expect(fake.deleteWorker).not.toHaveBeenCalled();
  });

  test("on a confirmed account it says whether a script of exactly that name is deployed", async () => {
    const fake = fakeWorkers(["acme-f69-demo--api"]);
    const scripts = cloudflareWorkerScripts(fake.clients, { accountId: "acct-ours", confirmation: "pinned" });

    expect(await scripts.exists("acme-f69-demo--api")).toBe(true);
    expect(await scripts.exists("acme-f69-demo--web")).toBe(false);
  });

  // A feature's Workers call each other, and Cloudflare refuses to delete a callee while its caller still
  // binds it. Every Worker teardown deletes is the feature's own and goes in the same pass, so it forces.
  test("delete removes the script by name, whatever still binds it", async () => {
    const fake = fakeWorkers(["acme-f69-demo--api"]);
    const scripts = cloudflareWorkerScripts(fake.clients, { accountId: "acct-ours", confirmation: "named" });

    await scripts.delete("acme-f69-demo--api");

    expect(fake.deleteWorker).toHaveBeenCalledWith("acme-f69-demo--api", { force: true });
  });
});

/**
 * **A feature's Artifacts namespace goes once its repos have (#673).** A repo delete is `202 Accepted`, so the
 * namespace can still answer `409` for a moment after the last repo was reaped. The seam waits that out, a bounded
 * number of times, and an already-gone namespace is nothing to do.
 */
describe("cloudflareFeatureRepos removing a namespace", () => {
  function fakeArtifacts(answers: ("deleted" | "absent" | "occupied")[]) {
    const deleteNamespace = vi.fn(async () => answers.shift() ?? "occupied");
    const clients = { artifacts: () => ({ deleteNamespace }) } as unknown as CloudflareClients;
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    return { clients, deleteNamespace, waits, wait };
  }

  test("deletes an empty namespace and says it was there", async () => {
    const fake = fakeArtifacts(["deleted"]);
    const repos = cloudflareFeatureRepos(fake.clients, { wait: fake.wait });
    expect(await repos.removeNamespace("acme-f662-thing--artifacts")).toBe(true);
    expect(fake.deleteNamespace).toHaveBeenCalledWith("acme-f662-thing--artifacts");
    expect(fake.waits).toEqual([]);
  });

  test("a namespace already gone, or never created, is not an error", async () => {
    const fake = fakeArtifacts(["absent"]);
    const repos = cloudflareFeatureRepos(fake.clients, { wait: fake.wait });
    expect(await repos.removeNamespace("ns")).toBe(false);
  });

  test("waits out a namespace still releasing a repo just reaped, then deletes it", async () => {
    const fake = fakeArtifacts(["occupied", "occupied", "deleted"]);
    const repos = cloudflareFeatureRepos(fake.clients, { wait: fake.wait });
    expect(await repos.removeNamespace("ns")).toBe(true);
    expect(fake.deleteNamespace).toHaveBeenCalledTimes(3);
    expect(fake.waits).toEqual([1000, 2000]);
  });

  test("a namespace that stays occupied is refused by name, with the re-run that finishes it", async () => {
    const fake = fakeArtifacts([]);
    const repos = cloudflareFeatureRepos(fake.clients, { wait: fake.wait });
    const failure = repos.removeNamespace("acme-f662-thing--artifacts");
    await expect(failure).rejects.toBeInstanceOf(PithyError);
    await expect(failure).rejects.toThrow(/acme-f662-thing--artifacts/);
    expect(fake.waits).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(fake.deleteNamespace).toHaveBeenCalledTimes(6);
  });
});
