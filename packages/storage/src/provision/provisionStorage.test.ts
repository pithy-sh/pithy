// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
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

/** The project every name in this suite leads with — the root `pithy.config.ts` `name`. */
const PROJECT = "acme";

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
        return { bucketName: storageBucketName(PROJECT, env) };
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
  test("buckets and workers are per environment, so staging cannot delete prod's files", () => {
    expect(storageBucketName(PROJECT, "staging")).toBe("acme-staging-storage");
    expect(storageBucketName(PROJECT, "prod")).toBe("acme-prod-storage");
    expect(storageWorkerName(PROJECT, "staging")).toBe("acme-staging-storage");
  });

  test("two projects in one account never name the same bucket, so find-then-create cannot adopt", () => {
    expect(storageBucketName("acme", "prod")).not.toBe(storageBucketName("globex", "prod"));
    expect(storageWorkerName("acme", "prod")).not.toBe(storageWorkerName("globex", "prod"));
  });

  test("the project name is kebabbed, so a human-typed `Acme Corp` still yields a legal name", () => {
    expect(storageBucketName("Acme Corp", "staging")).toBe("acme-corp-staging-storage");
  });

  test("a bucket name obeys R2's charset and its 3–63 length, at the longest legal project name", () => {
    // R2 is the one namespace where 63 was always the right number, and the only one with a minimum and
    // a start-and-end-alphanumeric rule. The facade holds the bucket to that rule specifically, rather
    // than to a generic budget that happens to match today.
    const name = storageBucketName("a".repeat(MAX_PROJECT_NAME), "staging");
    expect(name.length).toBeGreaterThanOrEqual(3);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  test("both names refuse an environment this project scheme does not accept", () => {
    // A bucket is found by name and adopted; a Worker deploy upserts. A stale `production` would quietly
    // stand up a second set of both, beside the real ones, wired to nothing.
    expect(() => storageBucketName(PROJECT, "production" as ManagedEnvironment)).toThrow(/prod/);
    expect(() => storageWorkerName(PROJECT, "production" as ManagedEnvironment)).toThrow(/prod/);
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
      "ensureBucket:prod",
      "credentials:staging:acme-staging-storage",
      "credentials:prod:acme-prod-storage",
      "deploy:staging:acme-staging-storage",
      "deploy:prod:acme-prod-storage",
    ]);
    expect(result).toEqual({
      environments: [
        { env: "staging", bucketName: "acme-staging-storage" },
        { env: "prod", bucketName: "acme-prod-storage" },
      ],
    });
  });

  test("a failure creating prod's bucket stops the run before staging's worker is deployed", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const failing: StorageProvisioner = {
      ...provisioner,
      ensureBucket: async (env) => {
        if (env === "prod") throw new Error("bucket quota exceeded");
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
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:prod"]);
  });

  test("deletes the buckets only when asked, and only after the workers that bind them are gone", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionStorage(deprovisioner, { deleteStorage: true });
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:prod", "deleteBucket:staging", "deleteBucket:prod"]);
  });
});
