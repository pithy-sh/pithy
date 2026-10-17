// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { MediaConfig } from "@pithy-sh/media/src/config/config";
import { mediaBucketName, mediaWorkerName } from "@pithy-sh/media/src/provision/provisionMedia";
import { resolveMediaConfig } from "@pithy-sh/media/src/provision/resolveMediaConfig";
import { parse } from "comment-json";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { kitSource } from "../project/kitSource";
import { KIT_ROOT } from "../test-utils/kitRoot";
import { CloudflareMediaDeprovisioner, CloudflareMediaProvisioner } from "./mediaProvisioner";

/** The project every provisioned name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "acme";

/** Resources are per environment; staging stands in for both in these tests. */
const STAGING_BUCKET = mediaBucketName(PROJECT, "staging");

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
  const signingKeys = vi.fn(async () => [{ name: "default", value: "images-secret" }]);
  const createImagesKey = vi.fn(async () => [{ name: "pithy", value: "fresh-secret" }]);
  const listVariants = vi.fn(async () => [
    { id: "public", neverRequireSignedURLs: false },
    { id: "thumb", neverRequireSignedURLs: true },
  ]);
  const createStreamKey = vi.fn(async () => ({ id: "kid-1", jwk: "eyJr" }));
  const cf = {
    r2Provisioner: () => ({ findBucketByName, createBucket, deleteBucket }),
    r2: () => ({ emptyBucket }),
    workers: () => ({ getWorker, deleteWorker, accountSubdomain }),
    images: () => ({ signingKeys, createSigningKey: createImagesKey, listVariants }),
    stream: () => ({ createSigningKey: createStreamKey }),
  } as unknown as CloudflareClients;
  return {
    cf,
    calls,
    findBucketByName,
    createBucket,
    deleteBucket,
    emptyBucket,
    signingKeys,
    createImagesKey,
    listVariants,
    createStreamKey,
    getWorker,
    deleteWorker,
    accountSubdomain,
  };
}

/** A provisioner over the fake clients. `deployWorker` is never reached by these tests. */
function provisioner(cf: CloudflareClients, config: MediaConfig, events: CliAuditEvent[]) {
  return new CloudflareMediaProvisioner({
    projectDir: KIT_ROOT,
    project: PROJECT,
    cf,
    account: { accountId: "acct-1", confirmation: "pinned" },
    apiToken: "tok",
    storeId: "store-1",
    mediaApiToken: "media-tok",
    r2Credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
    mediaConfig: config,
    dispatcher: { dispatch: async () => {} },
    environments: DEFAULT_ENVIRONMENTS,
    resolveEnv: async () => {
      throw new Error("not used by these tests");
    },
    audit: async (event) => void events.push(event),
  });
}

describe("CloudflareMediaProvisioner", () => {
  test("preflight refuses an account with no workers.dev subdomain, which Workflows require", async () => {
    const { cf, accountSubdomain } = fakeCf();
    const media = provisioner(cf, MediaConfig.parse({}), []);

    accountSubdomain.mockResolvedValue(null);
    await expect(media.preflight()).rejects.toThrow(/workers\.dev subdomain/);

    accountSubdomain.mockResolvedValue("acme");
    await expect(media.preflight()).resolves.toBeUndefined();
  });

  test("ensureBucket audits a create, and records nothing when it reuses the bucket", async () => {
    const { cf, findBucketByName, createBucket } = fakeCf();
    const events: CliAuditEvent[] = [];
    const media = provisioner(cf, MediaConfig.parse({}), events);

    findBucketByName.mockResolvedValue(null);
    createBucket.mockResolvedValue({ name: STAGING_BUCKET });
    expect(await media.ensureBucket("staging")).toEqual({ bucketName: STAGING_BUCKET });
    expect(events).toEqual([
      expect.objectContaining({
        action: "media/bucket_created",
        outcome: "success",
        severity: "info",
        resourceType: "cf_r2_bucket",
        resourceId: STAGING_BUCKET,
      }),
    ]);

    events.length = 0;
    createBucket.mockClear();
    findBucketByName.mockResolvedValue({ name: STAGING_BUCKET });
    expect(await media.ensureBucket("staging")).toEqual({ bucketName: STAGING_BUCKET });
    expect(createBucket).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test("unsignedVariants names every Images variant that serves an image unsigned", async () => {
    const { cf } = fakeCf();
    expect(await provisioner(cf, MediaConfig.parse({}), []).unsignedVariants()).toEqual(["thumb"]);
  });

  /** A provisioner recording every secret it writes, and answering whether one is held. */
  function signing(config: MediaConfig, held: readonly string[] = []) {
    const fake = fakeCf();
    const writes: { name: string; value: unknown }[] = [];
    const events: CliAuditEvent[] = [];
    const media = new CloudflareMediaProvisioner({
      projectDir: KIT_ROOT,
      project: PROJECT,
      cf: fake.cf,
      account: { accountId: "acct-1", confirmation: "pinned" },
      apiToken: "tok",
      storeId: "store-1",
      mediaApiToken: "media-tok",
      r2Credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
      mediaConfig: config,
      dispatcher: {
        dispatch: async (request) => {
          if (request.mode === "create")
            writes.push({ name: request.name, value: JSON.parse(request.value ?? "null") });
        },
      },
      probe: { probe: async ({ name }) => held.includes(name) },
      environments: DEFAULT_ENVIRONMENTS,
      resolveEnv: async () => {
        throw new Error("not used by these tests");
      },
      audit: async (event) => void events.push(event),
    });
    return { ...fake, media, writes, events };
  }

  test("writeSigningKeys stores the account's Images key and a new Stream key", async () => {
    const { media, writes, events, createStreamKey } = signing(MediaConfig.parse({}));
    await media.writeSigningKeys("staging");
    expect(writes).toEqual([
      { name: "media-images-signing-key", value: { key: "images-secret" } },
      { name: "media-stream-signing-key", value: { keyId: "kid-1", jwk: "eyJr" } },
    ]);
    expect(createStreamKey).toHaveBeenCalledTimes(1);
    expect(events).toEqual([expect.objectContaining({ action: "media/signing_keys_written" })]);
  });

  test("a re-run keeps the stored Stream key rather than minting one nothing signs with", async () => {
    const { media, writes, createStreamKey } = signing(MediaConfig.parse({}), ["media-stream-signing-key"]);
    await media.writeSigningKeys("staging");
    expect(createStreamKey).not.toHaveBeenCalled();
    expect(writes.map((write) => write.name)).toEqual(["media-images-signing-key"]);
  });

  test("an account with no Images key gets one", async () => {
    const { media, writes, signingKeys, createImagesKey } = signing(MediaConfig.parse({ video: { store: "r2" } }));
    signingKeys.mockResolvedValueOnce([]);
    await media.writeSigningKeys("staging");
    expect(createImagesKey).toHaveBeenCalledWith("pithy");
    expect(writes).toEqual([{ name: "media-images-signing-key", value: { key: "fresh-secret" } }]);
  });

  test("writes nothing where every record is public, or where nothing lives in Images or Stream", async () => {
    const everyonePublic = signing(MediaConfig.parse({ visibility: { default: "public", allowed: ["public"] } }));
    await everyonePublic.media.writeSigningKeys("staging");
    expect(everyonePublic.writes).toEqual([]);

    const allR2 = signing(MediaConfig.parse({ images: { store: "r2" }, video: { store: "r2" } }));
    await allR2.media.writeSigningKeys("staging");
    expect(allR2.writes).toEqual([]);
    expect(allR2.events).toEqual([]);
  });

  test("writeCredentials upserts both secrets — create first, update on the re-run that create rejects", async () => {
    const { cf } = fakeCf();
    const events: CliAuditEvent[] = [];
    const writes: string[] = [];
    const media = new CloudflareMediaProvisioner({
      projectDir: KIT_ROOT,
      project: PROJECT,
      cf,
      account: { accountId: "acct-1", confirmation: "pinned" },
      apiToken: "tok",
      storeId: "store-1",
      mediaApiToken: "media-tok",
      r2Credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
      mediaConfig: MediaConfig.parse({}),
      dispatcher: {
        dispatch: async (request) => {
          writes.push(`${request.mode}:${request.name}`);
          if (request.mode === "create") throw new Error("already exists");
        },
      },
      resolveEnv: async () => {
        throw new Error("not used by these tests");
      },
      audit: async (event) => void events.push(event),
      environments: DEFAULT_ENVIRONMENTS,
    });

    await media.writeCredentials("staging", { bucketName: STAGING_BUCKET });
    // Both secrets, each upserted: the R2 bundle the ObjectStore reads, then media's own Images +
    // Stream token. One audit event covers the pair — nothing can write one and not the other.
    expect(writes).toEqual([
      "create:media-r2-credentials",
      "update:media-r2-credentials",
      "create:media-storage-credentials",
      "update:media-storage-credentials",
    ]);
    expect(events).toEqual([expect.objectContaining({ action: "media/credentials_written", resourceType: "secret" })]);
  });

  test("writeCredentials surfaces both legs when the update fails too", async () => {
    const { cf } = fakeCf();
    const media = new CloudflareMediaProvisioner({
      projectDir: KIT_ROOT,
      project: PROJECT,
      cf,
      account: { accountId: "acct-1", confirmation: "pinned" },
      apiToken: "tok",
      storeId: "store-1",
      mediaApiToken: "media-tok",
      r2Credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
      mediaConfig: MediaConfig.parse({}),
      dispatcher: {
        dispatch: async (request) => {
          throw new Error(`${request.mode} refused`);
        },
      },
      resolveEnv: async () => {
        throw new Error("not used by these tests");
      },
      environments: DEFAULT_ENVIRONMENTS,
    });

    await expect(media.writeCredentials("prod", { bucketName: STAGING_BUCKET })).rejects.toThrow(
      /Could not write the media storage credentials to prod/,
    );
  });
});

describe("CloudflareMediaDeprovisioner", () => {
  /** The key pair a bucket teardown runs on. Values are arbitrary; only their presence matters. */
  const R2 = { accessKeyId: "ak", secretAccessKey: "sk" };

  test("deletes only what exists, and audits every deletion as a warning", async () => {
    const { cf, calls, getWorker, deleteWorker, findBucketByName, deleteBucket } = fakeCf();
    const events: CliAuditEvent[] = [];
    const media = new CloudflareMediaDeprovisioner({
      projectDir: KIT_ROOT,
      account: { accountId: "acct-1", confirmation: "pinned" },
      project: PROJECT,
      cf,
      r2Credentials: R2,
      audit: async (event) => void events.push(event),
    });

    getWorker.mockResolvedValue(null);
    findBucketByName.mockResolvedValue(null);
    await media.deleteWorker("staging");
    await media.deleteBucket("staging");
    expect(deleteWorker).not.toHaveBeenCalled();
    expect(deleteBucket).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    getWorker.mockResolvedValue({ id: mediaWorkerName(PROJECT, "staging") });
    findBucketByName.mockResolvedValue({ name: STAGING_BUCKET });
    await media.deleteWorker("staging");
    await media.deleteBucket("staging");
    expect(deleteWorker).toHaveBeenCalledWith(mediaWorkerName(PROJECT, "staging"));
    // The bucket is emptied before it is deleted. R2 refuses to delete one that still holds an object or
    // a dangling multipart upload, so a delete-only teardown fails on every bucket that was ever used.
    expect(calls).toEqual(["emptyBucket", `deleteBucket:${STAGING_BUCKET}`]);
    expect(events.map((event) => event.action)).toEqual(["media/worker_deleted", "media/bucket_deleted"]);
    expect(events.every((event) => event.severity === "warning")).toBe(true);
    // The audit records what went, not merely that the bucket did.
    expect(events[1]?.metadata).toMatchObject({ objectsDeleted: 4, uploadsAborted: 2 });
  });

  test("refuses a bucket teardown with no key pair, before anything is deleted", async () => {
    const { cf, calls, findBucketByName } = fakeCf();
    const media = new CloudflareMediaDeprovisioner({
      projectDir: KIT_ROOT,
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
    });

    findBucketByName.mockResolvedValue({ name: STAGING_BUCKET });
    await expect(media.deleteBucket("staging")).rejects.toThrowError(/R2 access-key pair is needed/);
    expect(calls).toEqual([]);
  });
});

describe("the committed media worker template", () => {
  /** The real file `deployWorker` reads — parsed exactly as the provisioner parses it. */
  async function committedTemplate(): Promise<WorkflowHostTemplate> {
    const dir = dirname(kitSource(KIT_ROOT, "@pithy-sh/media/src/workflows/worker"));
    return parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
  }

  test("resolves into a config with no placeholder left", async () => {
    const resolved = resolveMediaConfig(await committedTemplate(), {
      project: PROJECT,
      env: "staging",
      appDatabaseId: "app-1",
      secretsDatabaseId: "sec-1",
      storeId: "store-1",
      resources: { bucketName: STAGING_BUCKET },
      mediaConfig: MediaConfig.parse({}),
    });

    expect(resolved.name).toBe("acme-staging-media");
    expect(JSON.stringify(resolved)).not.toContain("<filled-at-provision>");
    // Records live in D1 alone, so the host binds no KV namespace at all.
    expect(resolved.kv_namespaces).toBeUndefined();
    expect(resolved.workflows?.map((workflow) => workflow.name)).toEqual([
      "acme-staging-media-image-to-text",
      "acme-staging-media-audio-transcribe",
      "acme-staging-media-video-transcribe",
      "acme-staging-media-doc-extract",
    ]);
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
    const stranger = new CloudflareMediaDeprovisioner({
      projectDir: KIT_ROOT,
      cf,
      project: PROJECT,
      account: { accountId: "acct-stranger", confirmation: "ambient" },
    });

    await expect(stranger.deleteWorker("prod")).rejects.toThrow(
      "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.",
    );
    expect(deleteWorker).not.toHaveBeenCalled();
    expect(getWorker).not.toHaveBeenCalled();
  });

  test("a confirmed account still tears down", async () => {
    const { cf, getWorker, deleteWorker } = fakeCf();
    getWorker.mockResolvedValue({ id: "acme-prod-media" });
    const ours = new CloudflareMediaDeprovisioner({
      projectDir: KIT_ROOT,
      cf,
      project: PROJECT,
      account: { accountId: "acct-ours", confirmation: "recorded" },
    });

    await ours.deleteWorker("prod");
    expect(deleteWorker).toHaveBeenCalledTimes(1);
  });
});
