import type { R2Bucket } from "@cloudflare/workers-types";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { SecretsAccessor } from "@pithy-sh/secrets/src/secretsStore";
import {
  aggregateSecretRegistries,
  configureSharedSecrets,
  resetSharedSecrets,
  type sharedSecretsStore,
} from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type R2StorageCredentials, STORAGE_R2_SECRET, storageSecretsRegistry } from "../secret/registry";
import { objectStore, type PresignedObjects } from "./store";

const env = {} as Parameters<typeof sharedSecretsStore>[0];

const credentials: R2StorageCredentials = {
  accountId: "acct-1",
  accessKeyId: "ak-1",
  secretAccessKey: "sk-1",
  bucket: "pithy-storage",
  apiToken: "tok-1",
};

/** Declare storage's slice and resolve it to `credentials`, the way a composed backend would. */
function configureSecrets(): void {
  const capability = defineCapability({
    name: "storage",
    requiredBindings: [],
    secretRegistry: storageSecretsRegistry,
  });
  const combined = aggregateSecretRegistries([capability]);
  configureSharedSecrets({
    registry: combined,
    resolve: async () =>
      new SecretsAccessor(combined, {
        [STORAGE_R2_SECRET]: { current: credentials, currentVersion: "1", versions: { "1": credentials } },
      }),
  });
}

/** A presign port that records what it was asked for — no SDK, no network. */
function fakePresigned(): PresignedObjects & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    presignPut: async (key, contentType, contentLength, options) => {
      calls.push(`put:${key}:${contentType}:${contentLength}:${options?.expiresIn ?? "default"}`);
      return `https://r2/${key}?put`;
    },
    presignGet: async (key) => {
      calls.push(`get:${key}`);
      return `https://r2/${key}?get`;
    },
    createMultipartUpload: async (key, contentType) => {
      calls.push(`init:${key}:${contentType}`);
      return "upload-1";
    },
    presignUploadPart: async (key, uploadId, partNumber, options) => {
      calls.push(`part:${key}:${uploadId}:${partNumber}:${options?.contentLength ?? "unsigned"}`);
      return `https://r2/${key}?part=${partNumber}`;
    },
    completeMultipartUpload: async (key, uploadId, parts) => {
      calls.push(`complete:${key}:${uploadId}:${parts.map((p) => p.partNumber).join(",")}`);
    },
    abortMultipartUpload: async (key, uploadId) => {
      calls.push(`abort:${key}:${uploadId}`);
    },
    listParts: async () => [{ partNumber: 1, etag: "e1", size: 5 }],
    copyObject: async (source, destination) => {
      calls.push(`copy:${source}:${destination}`);
    },
  };
}

const uploaded = new Date(1_700_000_000_000);

/** The shape an `R2Object` presents to the seam. `body` marks it as an `R2ObjectBody`. */
function fakeObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "obj/1",
    size: 1024,
    etag: "abc123",
    httpMetadata: { contentType: "application/pdf", contentDisposition: 'attachment; filename="q3.pdf"' },
    uploaded,
    checksums: {},
    ...overrides,
  };
}

/** A bucket binding stub — every method the seam actually calls. */
function fakeBucket(overrides: Partial<Record<"get" | "head" | "list" | "delete", unknown>> = {}): R2Bucket {
  return {
    get: vi.fn(async () => fakeObject({ body: "stream" })),
    head: vi.fn(async () => fakeObject()),
    list: vi.fn(async () => ({ objects: [fakeObject()], truncated: false, cursor: undefined })),
    delete: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as R2Bucket;
}

afterEach(() => resetSharedSecrets());

describe("objectStore credential resolution", () => {
  test("resolves the named secret once, however many presigns follow", async () => {
    configureSecrets();
    const presigned = fakePresigned();
    const build = vi.fn(() => presigned);
    const store = objectStore({ bucket: fakeBucket(), env, secretName: STORAGE_R2_SECRET, presigned: build });

    await Promise.all([store.presignGet("obj/1"), store.presignGet("obj/2")]);
    await store.presignPut("obj/3", "application/pdf", 10);
    expect(build).toHaveBeenCalledTimes(1);
  });

  test("never touches the secrets store for a binding-only read", async () => {
    // Deliberately unconfigured: a read-only worker must not need credentials at all.
    const store = objectStore({ bucket: fakeBucket(), env, presigned: () => fakePresigned() });
    await expect(store.head("obj/1")).resolves.toMatchObject({ key: "obj/1" });
    await expect(store.delete("obj/1")).resolves.toBeUndefined();
  });

  test("a secret name no capability declared fails loudly on first presign", async () => {
    configureSecrets();
    const store = objectStore({ bucket: fakeBucket(), env, secretName: "never-declared", presigned: fakePresigned });
    await expect(store.presignGet("obj/1")).rejects.toThrowError(/not in the aggregated registry/);
  });
});

describe("objectStore presigned surface", () => {
  test("forwards every multipart step to the S3 port, unsigned part lengths by default", async () => {
    configureSecrets();
    const presigned = fakePresigned();
    const store = objectStore({ bucket: fakeBucket(), env, presigned: () => presigned });

    const uploadId = await store.initMultipart("obj/1", "video/mp4");
    await store.presignPart("obj/1", uploadId, 1);
    await store.presignPart("obj/1", uploadId, 2, { contentLength: 100 });
    await store.completeMultipart("obj/1", uploadId, [
      { partNumber: 1, etag: "a" },
      { partNumber: 2, etag: "b" },
    ]);
    await store.abortMultipart("obj/1", uploadId);
    await store.copy("obj/1", "obj/2");

    expect(presigned.calls).toEqual([
      "init:obj/1:video/mp4",
      "part:obj/1:upload-1:1:unsigned",
      "part:obj/1:upload-1:2:100",
      "complete:obj/1:upload-1:1,2",
      "abort:obj/1:upload-1",
      "copy:obj/1:obj/2",
    ]);
  });

  test("validates the parts the S3 port reports back", async () => {
    configureSecrets();
    const store = objectStore({ bucket: fakeBucket(), env, presigned: fakePresigned });
    expect(await store.listParts("obj/1", "upload-1")).toEqual([{ partNumber: 1, etag: "e1", size: 5 }]);
  });
});

describe("objectStore binding surface", () => {
  test("maps R2 metadata through the seam's schema", async () => {
    const store = objectStore({ bucket: fakeBucket(), env, presigned: fakePresigned });
    expect(await store.head("obj/1")).toEqual({
      key: "obj/1",
      size: 1024,
      etag: "abc123",
      contentType: "application/pdf",
      contentDisposition: 'attachment; filename="q3.pdf"',
      uploaded,
    });
  });

  test("a missing object is null, not a throw — absence is an answer the caller interprets", async () => {
    const bucket = fakeBucket({ head: vi.fn(async () => null), get: vi.fn(async () => null) });
    const store = objectStore({ bucket, env, presigned: fakePresigned });
    expect(await store.head("obj/gone")).toBe(null);
    expect(await store.get("obj/gone")).toBe(null);
  });

  test("a failed precondition surfaces as metadata with a null body — the 304 signal", async () => {
    const bucket = fakeBucket({ get: vi.fn(async () => fakeObject()) });
    const store = objectStore({ bucket, env, presigned: fakePresigned });
    const result = await store.get("obj/1", { onlyIf: { etagDoesNotMatch: "abc123" } });
    expect(result?.body).toBe(null);
    expect(result?.metadata.etag).toBe("abc123");
  });

  test("passes a range through in the one shape R2's union accepts", async () => {
    const get = vi.fn(async (_key: string, options?: { range?: unknown }) => {
      void options;
      return fakeObject({ body: "stream", range: { offset: 10, length: 20 } });
    });
    const store = objectStore({ bucket: fakeBucket({ get }), env, presigned: fakePresigned });

    const result = await store.get("obj/1", { range: { offset: 10, length: 20 } });
    expect(get.mock.calls[0]?.[1]).toMatchObject({ range: { offset: 10, length: 20 } });
    expect(result?.range).toEqual({ offset: 10, length: 20 });
    // `size` stays the whole object's, which is what a `Content-Range` header needs.
    expect(result?.metadata.size).toBe(1024);
  });

  test("a suffix range wins over offset/length, matching `bytes=-N`", async () => {
    const get = vi.fn(async (_key: string, options?: { range?: unknown }) => {
      void options;
      return fakeObject({ body: "stream" });
    });
    const store = objectStore({ bucket: fakeBucket({ get }), env, presigned: fakePresigned });
    await store.get("obj/1", { range: { suffix: 500, offset: 10 } });
    expect(get.mock.calls[0]?.[1]).toMatchObject({ range: { suffix: 500 } });
  });

  test("returns a cursor only when the page is truncated, so a caller cannot loop forever", async () => {
    const untruncated = objectStore({ bucket: fakeBucket(), env, presigned: fakePresigned });
    expect((await untruncated.list({ prefix: "obj/" })).cursor).toBeUndefined();

    const bucket = fakeBucket({
      list: vi.fn(async () => ({ objects: [fakeObject()], truncated: true, cursor: "next" })),
    });
    const truncated = objectStore({ bucket, env, presigned: fakePresigned });
    expect((await truncated.list()).cursor).toBe("next");
  });

  test("rejects a bucket response that does not match the seam's schema", async () => {
    const bucket = fakeBucket({ head: vi.fn(async () => fakeObject({ size: -1 })) });
    const store = objectStore({ bucket, env, presigned: fakePresigned });
    await expect(store.head("obj/1")).rejects.toThrow();
  });
});
