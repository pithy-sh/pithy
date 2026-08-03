// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { MEDIA_CAPABILITY } from "../workflows/specs";
import {
  deprovisionMedia,
  type MediaDeprovisioner,
  type MediaProvisioner,
  mediaBucketName,
  mediaKvTitle,
  mediaWorkerName,
  provisionMedia,
} from "./provisionMedia";

/** The project every name in this suite leads with — the root `pithy.config.ts` `name`. */
const PROJECT = "acme";

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
        return { bucketName: mediaBucketName(PROJECT, env) };
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
      "ensureBucket:prod",
      "ensureKvNamespace:prod",
      "credentials:staging:acme-staging-media:-",
      "credentials:prod:acme-prod-media:-",
      "deploy:staging:acme-staging-media:-",
      "deploy:prod:acme-prod-media:-",
    ]);
    expect(result).toEqual({
      environments: [
        { env: "staging", bucketName: "acme-staging-media", kvNamespaceId: null },
        { env: "prod", bucketName: "acme-prod-media", kvNamespaceId: null },
      ],
    });
  });

  test("each environment gets its own bucket and namespace, so staging cannot write into prod", async () => {
    const { provisioner } = fakeProvisioner("kv-1");
    const result = await provisionMedia(provisioner);
    const buckets = result.environments.map((entry) => entry.bucketName);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets).toEqual(["acme-staging-media", "acme-prod-media"]);
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
    expect(calls).toContain("credentials:staging:acme-staging-media:kv-1");
    expect(calls).toContain("deploy:prod:acme-prod-media:kv-1");
    expect(result.environments.every((entry) => entry.kvNamespaceId === "kv-1")).toBe(true);
  });
});

describe("names", () => {
  test("the host worker is named for the project and the environment", () => {
    expect(mediaWorkerName(PROJECT, "staging")).toBe("acme-staging-media");
    expect(mediaWorkerName(PROJECT, "prod")).toBe("acme-prod-media");
  });

  test("the bucket and the KV namespace carry the same scope", () => {
    expect(mediaBucketName(PROJECT, "staging")).toBe("acme-staging-media");
    expect(mediaKvTitle(PROJECT, "prod")).toBe("acme-prod-media");
  });

  test("two projects in one account never name the same bucket, so find-then-create cannot adopt", () => {
    expect(mediaBucketName("acme", "prod")).not.toBe(mediaBucketName("globex", "prod"));
    expect(mediaKvTitle("acme", "prod")).not.toBe(mediaKvTitle("globex", "prod"));
    expect(mediaWorkerName("acme", "prod")).not.toBe(mediaWorkerName("globex", "prod"));
  });

  test("all three come from the naming facade, each asking for its own kind of resource", () => {
    // The point of the facade is that no call site picks a budget. A bucket asks for a bucket, a
    // namespace title asks for a title, a Worker asks for a Worker — and each carries its own
    // Cloudflare limit and its own refuse-or-truncate policy. Media names one thing three ways, so
    // this is the assertion that keeps the three from drifting back onto one number.
    const names = resourceNames(PROJECT).env("prod");
    expect(mediaBucketName(PROJECT, "prod")).toBe(names.r2(MEDIA_CAPABILITY));
    expect(mediaKvTitle(PROJECT, "prod")).toBe(names.kv(MEDIA_CAPABILITY));
    expect(mediaWorkerName(PROJECT, "prod")).toBe(names.worker(MEDIA_CAPABILITY));
  });

  test("the longest legal project still fits every one of the three namespaces", () => {
    const longest = "a".repeat(MAX_PROJECT_NAME);
    const bucket = mediaBucketName(longest, "staging");
    expect(bucket.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.r2.maxLength);
    expect(bucket.length).toBeGreaterThanOrEqual(NAMESPACE_LIMITS.r2.minLength);
    // R2's own charset rule: lowercase, digits, hyphens, starting and ending alphanumeric.
    expect(bucket).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(mediaKvTitle(longest, "staging").length).toBeLessThanOrEqual(NAMESPACE_LIMITS.kv.maxLength);
    expect(mediaWorkerName(longest, "staging").length).toBeLessThanOrEqual(NAMESPACE_LIMITS.worker.maxLength);
  });

  test("an environment this scheme does not accept is refused, so `production` cannot buy a fourth bucket", () => {
    // The cast is the test. `ManagedEnvironment` keeps the old spelling out of typed code, but the
    // value that reaches provisioning began life as a `--env` string, and the generic composer these
    // three used to call validated only that the segment was non-empty — so `production` composed a
    // perfectly legal `acme-production-media` and provisioning created it. The facade validates the
    // environment at `env()`, which is the last place that can still say no.
    const wrong = "production" as ManagedEnvironment;
    expect(() => mediaBucketName(PROJECT, wrong)).toThrow(ValidationError);
    expect(() => mediaKvTitle(PROJECT, wrong)).toThrow(ValidationError);
    expect(() => mediaWorkerName(PROJECT, wrong)).toThrow(ValidationError);
  });

  test("a project name no Cloudflare namespace could carry is refused before anything is created", () => {
    expect(() => mediaBucketName("2026 launch", "staging")).toThrow(ValidationError);
    expect(() => mediaKvTitle("a".repeat(MAX_PROJECT_NAME + 1), "staging")).toThrow(ValidationError);
    expect(() => mediaWorkerName("", "staging")).toThrow(ValidationError);
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
    expect(calls).toEqual(["deleteWorker:staging", "deleteWorker:prod"]);
  });

  test("deletes the bucket and namespace only when explicitly asked, after the workers", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionMedia(deprovisioner, { deleteStorage: true });
    expect(calls).toEqual([
      "deleteWorker:staging",
      "deleteWorker:prod",
      "deleteBucket:staging",
      "deleteKvNamespace:staging",
      "deleteBucket:prod",
      "deleteKvNamespace:prod",
    ]);
  });
});
