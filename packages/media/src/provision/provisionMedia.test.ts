// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import {
  deprovisionMedia,
  type MediaDeprovisioner,
  type MediaProvisioner,
  mediaWorkerName,
  provisionMedia,
} from "./provisionMedia";

/** A fake provisioner that records the call order and returns fixed resource ids. */
function fakeProvisioner(kvNamespaceId: string | null = null): { provisioner: MediaProvisioner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provisioner: {
      async preflight() {
        calls.push("preflight");
      },
      async ensureBucket(env: ManagedEnvironment) {
        calls.push(`ensureBucket:${env}`);
        return { bucketName: `pithy-media-${env}` };
      },
      async ensureKvNamespace(env: ManagedEnvironment) {
        calls.push(`ensureKvNamespace:${env}`);
        return kvNamespaceId ? { namespaceId: kvNamespaceId } : null;
      },
      async writeCredentials(env, resources) {
        calls.push(`credentials:${env}:${resources.bucketName}:${resources.kvNamespaceId ?? "-"}`);
      },
      async deployWorker(env, resources) {
        calls.push(`deploy:${env}:${resources.bucketName}:${resources.kvNamespaceId ?? "-"}`);
      },
    },
  };
}

describe("provisionMedia", () => {
  test("creates the resources once, then writes credentials and deploys for every environment", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const result = await provisionMedia(provisioner);

    expect(calls).toEqual([
      "preflight",
      "ensureBucket:staging",
      "ensureKvNamespace:staging",
      "ensureBucket:production",
      "ensureKvNamespace:production",
      "credentials:staging:pithy-media-staging:-",
      "credentials:production:pithy-media-production:-",
      "deploy:staging:pithy-media-staging:-",
      "deploy:production:pithy-media-production:-",
    ]);
    expect(result).toEqual({
      environments: [
        { env: "staging", bucketName: "pithy-media-staging", kvNamespaceId: null },
        { env: "production", bucketName: "pithy-media-production", kvNamespaceId: null },
      ],
    });
  });

  test("each environment gets its own bucket and namespace, so staging cannot write into production", async () => {
    const { provisioner } = fakeProvisioner("kv-1");
    const result = await provisionMedia(provisioner);
    const buckets = result.environments.map((entry) => entry.bucketName);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets).toEqual(["pithy-media-staging", "pithy-media-production"]);
  });

  test("every environment's credentials land before any worker that reads them boots", async () => {
    const { provisioner, calls } = fakeProvisioner();
    await provisionMedia(provisioner);
    const credentialIndexes = calls.flatMap((call, index) => (call.startsWith("credentials:") ? [index] : []));
    const firstDeploy = calls.findIndex((call) => call.startsWith("deploy:"));
    expect(Math.max(...credentialIndexes)).toBeLessThan(firstDeploy);
  });

  test("threads the KV namespace id through to the secret and the deploy in KV mode", async () => {
    const { provisioner, calls } = fakeProvisioner("kv-1");
    const result = await provisionMedia(provisioner);
    expect(calls).toContain("credentials:staging:pithy-media-staging:kv-1");
    expect(calls).toContain("deploy:production:pithy-media-production:kv-1");
    expect(result.environments.every((entry) => entry.kvNamespaceId === "kv-1")).toBe(true);
  });
});

describe("mediaWorkerName", () => {
  test("is the env-suffixed host worker name", () => {
    expect(mediaWorkerName("staging")).toBe("pithy-media-staging");
    expect(mediaWorkerName("production")).toBe("pithy-media-production");
  });
});

describe("deprovisionMedia", () => {
  function fakeDeprovisioner(): { deprovisioner: MediaDeprovisioner; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      deprovisioner: {
        async deleteWorker(env) {
          calls.push(`deleteWorker:${env}`);
        },
        async deleteBucket(env: ManagedEnvironment) {
          calls.push(`deleteBucket:${env}`);
        },
        async deleteKvNamespace(env: ManagedEnvironment) {
          calls.push(`deleteKvNamespace:${env}`);
        },
      },
    };
  }

  test("deletes every worker and keeps the stored media by default", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionMedia(deprovisioner);
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:production"]);
  });

  test("deletes the bucket and namespace only when explicitly asked, after the workers", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionMedia(deprovisioner, { deleteStorage: true });
    expect(calls).toEqual([
      "deleteWorker:staging",
      "deleteWorker:production",
      "deleteBucket:staging",
      "deleteKvNamespace:staging",
      "deleteBucket:production",
      "deleteKvNamespace:production",
    ]);
  });
});
