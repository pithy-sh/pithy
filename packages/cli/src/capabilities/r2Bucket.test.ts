import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { describe, expect, test, vi } from "vitest";
import { deleteR2BucketWithContents, resolveR2Credentials } from "./r2Bucket";

/** The S3 key pair every teardown here runs on. Values are arbitrary; only their presence matters. */
const CREDENTIALS = { accessKeyId: "ak", secretAccessKey: "sk" };

/**
 * A fake CloudflareClients exposing only what a bucket teardown touches, recording every call in one
 * ordered log. The order is the assertion that matters: a drain after the delete is no drain at all.
 */
function fakeCf() {
  const calls: string[] = [];
  const findBucketByName = vi.fn(async (name: string) => ({ name }));
  const deleteBucket = vi.fn(async (name: string) => void calls.push(`deleteBucket:${name}`));
  const emptyBucket = vi.fn(async () => {
    calls.push("emptyBucket");
    return { objectsDeleted: 3, uploadsAborted: 1 };
  });
  const r2 = vi.fn(() => ({ emptyBucket }));
  const cf = {
    r2Provisioner: () => ({ findBucketByName, deleteBucket }),
    r2,
  } as unknown as CloudflareClients;
  return { cf, calls, findBucketByName, deleteBucket, emptyBucket, r2 };
}

describe("deleteR2BucketWithContents", () => {
  test("empties the bucket before deleting it, and reports what went", async () => {
    const { cf, calls, r2, deleteBucket } = fakeCf();

    expect(
      await deleteR2BucketWithContents({ cf, credentials: CREDENTIALS, bucketName: "pithy-storage-staging" }),
    ).toEqual({ deleted: true, objectsDeleted: 3, uploadsAborted: 1 });

    // R2 refuses to delete a non-empty bucket, so the drain has to come first — a delete-only teardown
    // fails against every bucket that holds a single object, which is every bucket anyone has used.
    expect(calls).toEqual(["emptyBucket", "deleteBucket:pithy-storage-staging"]);
    expect(r2).toHaveBeenCalledWith({ ...CREDENTIALS, bucketName: "pithy-storage-staging" });
    expect(deleteBucket).toHaveBeenCalledWith("pithy-storage-staging");
  });

  test("does nothing at all when the bucket is not there", async () => {
    const { cf, calls, findBucketByName } = fakeCf();
    findBucketByName.mockResolvedValue(null as unknown as { name: string });

    expect(await deleteR2BucketWithContents({ cf, credentials: CREDENTIALS, bucketName: "gone" })).toEqual({
      deleted: false,
      objectsDeleted: 0,
      uploadsAborted: 0,
    });
    expect(calls).toEqual([]);
  });

  test("refuses without the key pair, and deletes nothing", async () => {
    const { cf, calls } = fakeCf();

    await expect(deleteR2BucketWithContents({ cf, bucketName: "pithy-media-production" })).rejects.toThrowError(
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "validation/invalid_input",
          message: "The R2 access-key pair is needed to delete the pithy-media-production bucket.",
        }),
      }),
    );
    expect(calls).toEqual([]);
  });
});

describe("resolveR2Credentials", () => {
  test("prefers the flags, then R2_CREDENTIALS", () => {
    expect(resolveR2Credentials("flag-ak", "flag-sk", '{"accessKeyId":"env-ak","secretAccessKey":"env-sk"}')).toEqual({
      accessKeyId: "flag-ak",
      secretAccessKey: "flag-sk",
    });
    expect(resolveR2Credentials(undefined, undefined, '{"accessKeyId":"env-ak","secretAccessKey":"env-sk"}')).toEqual({
      accessKeyId: "env-ak",
      secretAccessKey: "env-sk",
    });
  });

  test("names the fix for a half-supplied pair, an absent one, and malformed JSON", () => {
    expect(() => resolveR2Credentials("only-ak", undefined, undefined)).toThrowError(
      expect.objectContaining({
        payload: expect.objectContaining({ message: "The R2 access-key pair is incomplete." }),
      }),
    );
    expect(() => resolveR2Credentials(undefined, undefined, undefined)).toThrowError(
      expect.objectContaining({
        payload: expect.objectContaining({ message: "No R2 S3 credentials were supplied." }),
      }),
    );
    expect(() => resolveR2Credentials(undefined, undefined, "not json")).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ message: "R2_CREDENTIALS is not valid JSON." }) }),
    );
    expect(() => resolveR2Credentials(undefined, undefined, '{"accessKeyId":"ak"}')).toThrowError(
      expect.objectContaining({
        payload: expect.objectContaining({ message: "R2_CREDENTIALS is not a valid access-key/secret-key pair." }),
      }),
    );
  });
});
