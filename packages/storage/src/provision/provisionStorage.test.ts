// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import {
  deprovisionStorage,
  provisionStorage,
  type StorageDeprovisioner,
  type StorageProvisioner,
  storageBucketName,
  storageWorkerName,
} from "./provisionStorage";

/** A fake provisioner that records the call order — the orchestration's contract is that order. */
function fakeProvisioner(): { provisioner: StorageProvisioner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provisioner: {
      async preflight() {
        calls.push("preflight");
      },
      async ensureBucket(env: ManagedEnvironment) {
        calls.push(`ensureBucket:${env}`);
        return { bucketName: storageBucketName(env) };
      },
      async writeCredentials(env, resources) {
        calls.push(`credentials:${env}:${resources.bucketName}`);
      },
      async deployWorker(env, resources) {
        calls.push(`deploy:${env}:${resources.bucketName}`);
      },
    },
  };
}

describe("names", () => {
  test("buckets and workers are per environment, so staging cannot delete production's files", () => {
    expect(storageBucketName("staging")).toBe("pithy-storage-staging");
    expect(storageBucketName("production")).toBe("pithy-storage-production");
    expect(storageWorkerName("staging")).toBe("pithy-storage-staging");
  });
});

describe("provisionStorage", () => {
  test("checks the account, creates every bucket, then writes credentials, then deploys", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const result = await provisionStorage(provisioner);

    // The phase order is the contract: no secret may name a bucket that does not exist, and no worker
    // may boot before the secret it reads.
    expect(calls).toEqual([
      "preflight",
      "ensureBucket:staging",
      "ensureBucket:production",
      "credentials:staging:pithy-storage-staging",
      "credentials:production:pithy-storage-production",
      "deploy:staging:pithy-storage-staging",
      "deploy:production:pithy-storage-production",
    ]);
    expect(result).toEqual({
      environments: [
        { env: "staging", bucketName: "pithy-storage-staging" },
        { env: "production", bucketName: "pithy-storage-production" },
      ],
    });
  });

  test("a failure creating production's bucket stops the run before staging's worker is deployed", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const failing: StorageProvisioner = {
      ...provisioner,
      ensureBucket: async (env) => {
        if (env === "production") throw new Error("bucket quota exceeded");
        return provisioner.ensureBucket(env);
      },
    };

    await expect(provisionStorage(failing)).rejects.toThrow("bucket quota exceeded");
    expect(calls.some((call) => call.startsWith("deploy:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("credentials:"))).toBe(false);
  });

  test("re-running is a no-op on an already-provisioned account, because every step is idempotent", async () => {
    const { provisioner, calls } = fakeProvisioner();
    await provisionStorage(provisioner);
    const first = [...calls];
    calls.length = 0;
    await provisionStorage(provisioner);
    expect(calls).toEqual(first);
  });
});

/** A fake deprovisioner that records the call order. */
function fakeDeprovisioner(): { deprovisioner: StorageDeprovisioner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deprovisioner: {
      async deleteWorker(env: ManagedEnvironment) {
        calls.push(`deleteWorker:${env}`);
      },
      async deleteBucket(env: ManagedEnvironment) {
        calls.push(`deleteBucket:${env}`);
      },
    },
  };
}

describe("deprovisionStorage", () => {
  test("removes the workers and keeps the files — stored data is never collateral", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionStorage(deprovisioner);
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:production"]);
  });

  test("deletes the buckets only when asked, and only after the workers that bind them are gone", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionStorage(deprovisioner, { deleteStorage: true });
    expect(calls).toEqual([
      "deleteWorker:staging",
      "deleteWorker:production",
      "deleteBucket:staging",
      "deleteBucket:production",
    ]);
  });
});
