// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { StorageConfig } from "@pithy-sh/storage/src/config/config";
import { storageBucketName, storageWorkerName } from "@pithy-sh/storage/src/provision/provisionStorage";
import { resolveStorageConfig } from "@pithy-sh/storage/src/provision/resolveStorageConfig";
import { R2StorageCredentials } from "@pithy-sh/storage/src/secret/registry";
import { parse } from "comment-json";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { CloudflareStorageDeprovisioner, CloudflareStorageProvisioner } from "./storageProvisioner";

/** Resources are per environment; staging stands in for both in these tests. */
const STAGING_BUCKET = storageBucketName("staging");

/** A fake CloudflareClients exposing only the methods the (de)provisioner touches, with spies. */
function fakeCf() {
  const findBucketByName = vi.fn();
  const createBucket = vi.fn();
  const calls: string[] = [];
  const deleteBucket = vi.fn(async (name: string) => void calls.push(`deleteBucket:${name}`));
  const emptyBucket = vi.fn(async () => {
    calls.push("emptyBucket");
    return { objectsDeleted: 4, uploadsAborted: 2 };
  });
  const getWorker = vi.fn();
  const deleteWorker = vi.fn();
  const accountSubdomain = vi.fn();
  const cf = {
    r2Provisioner: () => ({ findBucketByName, createBucket, deleteBucket }),
    r2: () => ({ emptyBucket }),
    workers: () => ({ getWorker, deleteWorker, accountSubdomain }),
  } as unknown as CloudflareClients;
  return {
    cf,
    calls,
    findBucketByName,
    createBucket,
    deleteBucket,
    emptyBucket,
    getWorker,
    deleteWorker,
    accountSubdomain,
  };
}

/** A provisioner over the fake clients. `deployWorker` is never reached by these tests. */
function provisioner(
  cf: CloudflareClients,
  events: CliAuditEvent[],
  dispatch: (request: { mode: string }) => Promise<void> = async () => {},
) {
  return new CloudflareStorageProvisioner({
    cf,
    accountId: "acct-1",
    apiToken: "tok",
    storeId: "store-1",
    storageApiToken: "storage-tok",
    r2Credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
    storageConfig: StorageConfig.parse({}),
    dispatcher: { dispatch: dispatch as never },
    resolveEnv: async () => {
      throw new Error("not used by these tests");
    },
    audit: async (event) => void events.push(event),
  });
}

describe("CloudflareStorageProvisioner", () => {
  test("preflight refuses an account with no workers.dev subdomain, which Workflows require", async () => {
    const { cf, accountSubdomain } = fakeCf();
    const storage = provisioner(cf, []);

    accountSubdomain.mockResolvedValue(null);
    await expect(storage.preflight()).rejects.toThrow(/workers\.dev subdomain/);

    accountSubdomain.mockResolvedValue("acme");
    await expect(storage.preflight()).resolves.toBeUndefined();
  });

  test("ensureBucket audits a create, and records nothing when it reuses the bucket", async () => {
    const { cf, findBucketByName, createBucket } = fakeCf();
    const events: CliAuditEvent[] = [];
    const storage = provisioner(cf, events);

    findBucketByName.mockResolvedValue(null);
    createBucket.mockResolvedValue({ name: STAGING_BUCKET });
    expect(await storage.ensureBucket("staging")).toEqual({ bucketName: STAGING_BUCKET });
    expect(events).toEqual([
      expect.objectContaining({
        action: "storage/bucket_created",
        outcome: "success",
        resourceType: "cf_r2_bucket",
        resourceId: STAGING_BUCKET,
      }),
    ]);

    // Idempotent: a re-run finds the bucket and neither creates nor audits anything.
    events.length = 0;
    createBucket.mockClear();
    findBucketByName.mockResolvedValue({ name: STAGING_BUCKET });
    expect(await storage.ensureBucket("staging")).toEqual({ bucketName: STAGING_BUCKET });
    expect(createBucket).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test("writeCredentials validates the bundle before it is dispatched anywhere", async () => {
    const { cf } = fakeCf();
    const written: string[] = [];
    const storage = provisioner(cf, [], async (request) => {
      written.push(JSON.stringify(request));
    });

    await storage.writeCredentials("staging", { bucketName: STAGING_BUCKET });
    const payload = JSON.parse(written[0] ?? "{}") as { name: string; value: string; env: string };
    expect(payload.name).toBe("storage-r2-credentials");
    // An environment-scoped secret is routed to exactly the environment asked for.
    expect(payload.env).toBe("staging");
    // The value round-trips through the same schema the Worker reads it with.
    expect(R2StorageCredentials.parse(JSON.parse(payload.value))).toEqual({
      accessKeyId: "ak",
      secretAccessKey: "sk",
      accountId: "acct-1",
      bucket: STAGING_BUCKET,
      apiToken: "storage-tok",
    });
  });

  test("writeCredentials upserts — create first, update on the re-run that create rejects", async () => {
    const { cf } = fakeCf();
    const events: CliAuditEvent[] = [];
    const modes: string[] = [];
    const storage = provisioner(cf, events, async (request) => {
      modes.push(request.mode);
      if (request.mode === "create") throw new Error("already exists");
    });

    await storage.writeCredentials("staging", { bucketName: STAGING_BUCKET });
    expect(modes).toEqual(["create", "update"]);
    expect(events).toEqual([
      expect.objectContaining({ action: "storage/credentials_written", resourceType: "secret" }),
    ]);
  });

  test("writeCredentials surfaces both legs when the update fails too", async () => {
    const { cf } = fakeCf();
    const storage = provisioner(cf, [], async (request) => {
      throw new Error(`${request.mode} refused`);
    });

    await expect(storage.writeCredentials("production", { bucketName: STAGING_BUCKET })).rejects.toThrow(
      /Could not write the storage R2 credentials to production/,
    );
  });
});

describe("CloudflareStorageDeprovisioner", () => {
  /** The key pair a bucket teardown runs on. Values are arbitrary; only their presence matters. */
  const R2 = { accessKeyId: "ak", secretAccessKey: "sk" };

  test("deletes only what exists, and audits every deletion as a warning", async () => {
    const { cf, calls, getWorker, deleteWorker, findBucketByName, deleteBucket } = fakeCf();
    const events: CliAuditEvent[] = [];
    const storage = new CloudflareStorageDeprovisioner({
      cf,
      r2Credentials: R2,
      audit: async (event) => void events.push(event),
    });

    getWorker.mockResolvedValue(null);
    findBucketByName.mockResolvedValue(null);
    await storage.deleteWorker("staging");
    await storage.deleteBucket("staging");
    expect(deleteWorker).not.toHaveBeenCalled();
    expect(deleteBucket).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    getWorker.mockResolvedValue({ id: storageWorkerName("staging") });
    findBucketByName.mockResolvedValue({ name: STAGING_BUCKET });
    await storage.deleteWorker("staging");
    await storage.deleteBucket("staging");
    expect(deleteWorker).toHaveBeenCalledWith(storageWorkerName("staging"));
    // The bucket is emptied before it is deleted. R2 refuses to delete one that still holds an object or
    // a dangling multipart upload, so a delete-only teardown fails on every bucket that was ever used.
    expect(calls).toEqual(["emptyBucket", `deleteBucket:${STAGING_BUCKET}`]);
    expect(events.map((event) => event.action)).toEqual(["storage/worker_deleted", "storage/bucket_deleted"]);
    expect(events.every((event) => event.severity === "warning")).toBe(true);
    // The audit records what went, not merely that the bucket did.
    expect(events[1]?.metadata).toMatchObject({ objectsDeleted: 4, uploadsAborted: 2 });
  });

  test("refuses a bucket teardown with no key pair, before anything is deleted", async () => {
    const { cf, calls, findBucketByName } = fakeCf();
    const storage = new CloudflareStorageDeprovisioner({ cf });

    findBucketByName.mockResolvedValue({ name: STAGING_BUCKET });
    await expect(storage.deleteBucket("staging")).rejects.toThrowError(/R2 access-key pair is needed/);
    expect(calls).toEqual([]);
  });
});

describe("the committed sweep worker template", () => {
  /** The real file `deployWorker` reads — parsed exactly as the provisioner parses it. */
  async function committedTemplate(): Promise<WorkflowHostTemplate> {
    const dir = dirname(fileURLToPath(import.meta.resolve("@pithy-sh/storage/src/workflows/worker")));
    return parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
  }

  test("resolves into a config with no placeholder left", async () => {
    const resolved = resolveStorageConfig(await committedTemplate(), {
      env: "staging",
      appDatabaseId: "app-db",
      secretsDatabaseId: "secrets-db",
      storeId: "store-1",
      resources: { bucketName: STAGING_BUCKET },
      storageConfig: StorageConfig.parse({}),
    });
    expect(JSON.stringify(resolved)).not.toContain("filled-at-provision");
    expect(resolved.name).toBe(storageWorkerName("staging"));
    expect(resolved.r2_buckets?.[0]?.bucket_name).toBe(STAGING_BUCKET);
  });

  test("the template's own workflows block is replaced by the one the specs derive", async () => {
    const template = await committedTemplate();
    const resolved = resolveStorageConfig(template, {
      env: "production",
      appDatabaseId: "app-db",
      secretsDatabaseId: "secrets-db",
      storeId: "store-1",
      resources: { bucketName: storageBucketName("production") },
      storageConfig: StorageConfig.parse({}),
    });
    expect(resolved.workflows).toEqual([
      { binding: "STORAGE_SWEEP", name: "pithy-storage-sweep-production", class_name: "StorageSweepWorkflow" },
    ]);
    expect(resolved.triggers).toEqual({ crons: ["0 3 * * *"] });
  });
});
