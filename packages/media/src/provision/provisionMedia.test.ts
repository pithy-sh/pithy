// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { MediaConfig } from "../config/config";
import { MEDIA_CAPABILITY } from "../workflows/specs";
import {
  deprovisionMedia,
  type MediaDeprovisioner,
  type MediaProvisioner,
  mediaBucketName,
  mediaWorkerName,
  mediaWorkflowNames,
  provisionMedia,
} from "./provisionMedia";

/** The project every name in this suite leads with — the root `pithy.config.ts` `name`. */
const PROJECT = "acme";

/** A fake provisioner that records the call order and returns fixed resource ids. */
function fakeProvisioner(unsigned: string[] = []): { provisioner: MediaProvisioner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provisioner: {
      async preflight(environments) {
        calls.push(`preflight:${environments.join(",")}`);
      },
      async unsignedVariants() {
        calls.push("variants");
        return unsigned;
      },
      async ensureBucket(env: ManagedEnvironment) {
        calls.push(`ensureBucket:${env}`);
        return { bucketName: mediaBucketName(PROJECT, env) };
      },
      async writeCredentials(env, resources) {
        calls.push(`credentials:${env}:${resources.bucketName}`);
      },
      async writeSigningKeys(env) {
        calls.push(`signing:${env}`);
      },
      async deployWorker(env, resources) {
        calls.push(`deploy:${env}:${resources.bucketName}`);
      },
    },
  };
}

describe("provisionMedia", () => {
  test("creates the resources once, then writes credentials and deploys for every environment", async () => {
    const { provisioner, calls } = fakeProvisioner();
    const result = await provisionMedia(provisioner, DEFAULT_ENVIRONMENTS);

    expect(calls).toEqual([
      "preflight:staging,prod",
      "variants",
      "ensureBucket:staging",
      "ensureBucket:prod",
      "credentials:staging:acme-staging-media",
      "signing:staging",
      "credentials:prod:acme-prod-media",
      "signing:prod",
      "deploy:staging:acme-staging-media",
      "deploy:prod:acme-prod-media",
    ]);
    expect(result).toEqual({
      environments: [
        { env: "staging", bucketName: "acme-staging-media" },
        { env: "prod", bucketName: "acme-prod-media" },
      ],
    });
  });

  test("each environment gets its own bucket, so staging cannot write into prod", async () => {
    const { provisioner } = fakeProvisioner();
    const result = await provisionMedia(provisioner, DEFAULT_ENVIRONMENTS);
    const buckets = result.environments.map((entry) => entry.bucketName);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets).toEqual(["acme-staging-media", "acme-prod-media"]);
  });

  test("every environment's credentials land before any worker that reads them boots", async () => {
    const { provisioner, calls } = fakeProvisioner();
    await provisionMedia(provisioner, DEFAULT_ENVIRONMENTS);
    const credentialIndexes = calls.flatMap((call, index) => (call.startsWith("credentials:") ? [index] : []));
    const firstDeploy = calls.findIndex((call) => call.startsWith("deploy:"));
    expect(Math.max(...credentialIndexes)).toBeLessThan(firstDeploy);
  });

  test("preflight is told every environment it will write, so a refusal lands before any bundle is rewritten (#728)", async () => {
    const { provisioner, calls } = fakeProvisioner();
    provisioner.preflight = async (environments) => {
      calls.push(`preflight:${environments.join(",")}`);
      throw new ValidationError({ message: "prod has no runtime token." });
    };
    await expect(provisionMedia(provisioner, DEFAULT_ENVIRONMENTS)).rejects.toThrow(/no runtime token/);
    expect(calls).toEqual(["preflight:staging,prod"]);
  });

  test("every environment's signing keys land before any worker that signs with them boots", async () => {
    const { provisioner, calls } = fakeProvisioner();
    await provisionMedia(provisioner, DEFAULT_ENVIRONMENTS);
    const signing = calls.flatMap((call, index) => (call.startsWith("signing:") ? [index] : []));
    expect(Math.max(...signing)).toBeLessThan(calls.findIndex((call) => call.startsWith("deploy:")));
  });
});

describe("provisionMedia — a variant that serves unsigned", () => {
  test("is refused, by name, before anything is created, while images could be private", async () => {
    const { provisioner, calls } = fakeProvisioner(["thumb"]);
    await expect(provisionMedia(provisioner, DEFAULT_ENVIRONMENTS)).rejects.toThrow(
      /`thumb` serves every image unsigned/,
    );
    expect(calls).toEqual(["preflight:staging,prod", "variants"]);
  });

  test("names every one", async () => {
    const { provisioner } = fakeProvisioner(["thumb", "avatar"]);
    await expect(provisionMedia(provisioner, DEFAULT_ENVIRONMENTS)).rejects.toThrow(/`thumb`, `avatar` serve/);
  });

  test("is not asked about when every record is public — nothing private could leak", async () => {
    const { provisioner, calls } = fakeProvisioner(["thumb"]);
    const config = MediaConfig.parse({ visibility: { default: "public", allowed: ["public"] } });
    await provisionMedia(provisioner, DEFAULT_ENVIRONMENTS, { config });
    expect(calls).not.toContain("variants");
  });

  test("is not asked about when images live in R2", async () => {
    const { provisioner, calls } = fakeProvisioner(["thumb"]);
    await provisionMedia(provisioner, DEFAULT_ENVIRONMENTS, { config: MediaConfig.parse({ images: { store: "r2" } }) });
    expect(calls).not.toContain("variants");
  });
});

describe("names", () => {
  test("the host worker is named for the project and the environment", () => {
    expect(mediaWorkerName(PROJECT, "staging")).toBe("acme-staging-media");
    expect(mediaWorkerName(PROJECT, "prod")).toBe("acme-prod-media");
  });

  test("the bucket carries the same scope", () => {
    expect(mediaBucketName(PROJECT, "staging")).toBe("acme-staging-media");
  });

  test("two projects in one account never name the same bucket, so find-then-create cannot adopt", () => {
    expect(mediaBucketName("acme", "prod")).not.toBe(mediaBucketName("globex", "prod"));
    expect(mediaWorkerName("acme", "prod")).not.toBe(mediaWorkerName("globex", "prod"));
  });

  test("both come from the naming facade, each asking for its own kind of resource", () => {
    // The point of the facade is that no call site picks a budget. A bucket asks for a bucket and a
    // Worker asks for a Worker — and each carries its own Cloudflare limit and its own
    // refuse-or-truncate policy.
    const names = resourceNames(PROJECT).env("prod");
    expect(mediaBucketName(PROJECT, "prod")).toBe(names.r2(MEDIA_CAPABILITY));
    expect(mediaWorkerName(PROJECT, "prod")).toBe(names.worker(MEDIA_CAPABILITY));
  });

  test("the longest legal project still fits both namespaces", () => {
    const longest = "a".repeat(MAX_PROJECT_NAME);
    const bucket = mediaBucketName(longest, "staging");
    expect(bucket.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.r2.maxLength);
    expect(bucket.length).toBeGreaterThanOrEqual(NAMESPACE_LIMITS.r2.minLength);
    // R2's own charset rule: lowercase, digits, hyphens, starting and ending alphanumeric.
    expect(bucket).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(mediaWorkerName(longest, "staging").length).toBeLessThanOrEqual(NAMESPACE_LIMITS.worker.maxLength);
  });

  test("an environment this scheme does not accept is refused, so `production` cannot buy a fourth bucket", () => {
    // The cast is the test. `ManagedEnvironment` keeps the old spelling out of typed code, but the
    // value that reaches provisioning began life as a `--env` string, and the generic composer these
    // used to call validated only that the segment was non-empty — so `production` composed a
    // perfectly legal `acme-production-media` and provisioning created it. The facade validates the
    // environment at `env()`, which is the last place that can still say no.
    const wrong = "production" as ManagedEnvironment;
    expect(() => mediaBucketName(PROJECT, wrong)).toThrow(ValidationError);
    expect(() => mediaWorkerName(PROJECT, wrong)).toThrow(ValidationError);
  });

  test("a project name no Cloudflare namespace could carry is refused before anything is created", () => {
    expect(() => mediaBucketName("2026 launch", "staging")).toThrow(ValidationError);
    expect(() => mediaWorkerName("a".repeat(MAX_PROJECT_NAME + 1), "staging")).toThrow(ValidationError);
    expect(() => mediaWorkerName("", "staging")).toThrow(ValidationError);
  });
});

describe("mediaWorkflowNames", () => {
  test("names the four enrichment Workflows the host is deployed with, for one environment (#789)", () => {
    expect(mediaWorkflowNames(PROJECT, "staging")).toEqual([
      "acme-staging-media-image-to-text",
      "acme-staging-media-audio-transcribe",
      "acme-staging-media-video-transcribe",
      "acme-staging-media-doc-extract",
    ]);
  });
});

describe("deprovisionMedia", () => {
  function fakeDeprovisioner(): { deprovisioner: MediaDeprovisioner; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      deprovisioner: {
        async deleteWorkflows(env) {
          calls.push(`deleteWorkflows:${env}`);
        },
        async deleteWorker(env) {
          calls.push(`deleteWorker:${env}`);
        },
        async deleteBucket(env: ManagedEnvironment) {
          calls.push(`deleteBucket:${env}`);
        },
      },
    };
  }

  const staging = { environment: "staging", declared: DEFAULT_ENVIRONMENTS };

  test("deletes the named environment's worker and keeps the stored media by default", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionMedia(deprovisioner, staging);
    expect(calls).toEqual(["deleteWorkflows:staging", "deleteWorker:staging"]);
  });

  test("a staging teardown with --storage deletes staging's bucket, after its worker, and never production's (#591)", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await deprovisionMedia(deprovisioner, staging, { deleteStorage: true });
    expect(calls).toEqual(["deleteWorkflows:staging", "deleteWorker:staging", "deleteBucket:staging"]);
  });

  test("naming no environment refuses, lists the declared ones, and deletes nothing", async () => {
    const { deprovisioner, calls } = fakeDeprovisioner();
    await expect(
      deprovisionMedia(
        deprovisioner,
        { environment: undefined, declared: DEFAULT_ENVIRONMENTS },
        { deleteStorage: true },
      ),
    ).rejects.toThrow("Name the environment to deprovision. Nothing was deleted.");
    expect(calls).toEqual([]);
  });
});
