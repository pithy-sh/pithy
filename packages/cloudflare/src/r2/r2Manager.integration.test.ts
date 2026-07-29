import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, test } from "vitest";
import { CloudflareClients } from "../client/clients";
import { loadIntegrationCreds, reapStaleTestResources, uniqueName, withThrowawayResource } from "../test-utils/harness";
import type { CompletedPart } from "./r2Manager";
import { CloudflareR2Manager } from "./r2Manager";

/**
 * LIVE integration test — the R2 object plane. Every test creates a real bucket, drives the manager
 * against it over the S3 protocol, and empties + deletes the bucket in a guaranteed teardown.
 *
 * Multipart is the reason this file matters. Mocks assert which command the manager sends; they
 * cannot tell you that R2 refuses a sub-5-MiB part, that the ETag it hands back is quoted, that the
 * quoted form is exactly what `complete` wants back, or that a presigned part URL is usable by a
 * client at all. Those only surface over the wire, so the round trip here PUTs real bytes to real
 * presigned URLs and completes with the ETags R2 actually returned.
 *
 * Needs R2 enabled plus the S3 keys in `R2_CREDENTIALS`; skipped without them. See
 * `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();
const KEY = "greeting.txt";
const PAYLOAD = "saffron payload";
const BODY = new TextEncoder().encode(PAYLOAD);

/**
 * R2's floor for every part but the last: 5 MiB. Two full parts plus a short tail is the smallest
 * upload that is genuinely multipart, so that is what the round trip moves — 10 MiB over the wire is
 * the price of proving the constraint rather than assuming it.
 */
const PART_SIZE = 5 * 1024 * 1024;

/** A part body of `size` bytes, every byte `filler`. Distinct fillers make the assembled seam visible. */
function partBody(filler: number, size: number): Uint8Array {
  return new Uint8Array(size).fill(filler);
}

describe.skipIf(!creds.hasCreds || !creds.r2)("CloudflareR2Manager — LIVE", () => {
  // Non-null inside the suite: the skipIf above guarantees creds.r2 is present.
  const r2 = creds.r2 ?? { accessKeyId: "", secretAccessKey: "" };
  const r2Config = { accountId: creds.accountId, apiToken: creds.apiToken, ...r2 };
  const provisioner = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken }).r2Provisioner();

  // Teardown only runs while the process lives; a run killed mid-test orphans its bucket. Reaping first
  // makes each run clean up after the last, so an aborted run costs nothing beyond the next run's start.
  // A stale bucket may still hold objects, so empty it before deleting — R2 refuses a non-empty delete.
  beforeAll(async () => {
    await reapStaleTestResources({
      label: "R2 bucket",
      list: async () => (await provisioner.listBuckets()).map((bucket) => bucket.name),
      remove: async (name) => {
        await purgeBucket(name);
        await provisioner.deleteBucket(name);
      },
    });
  });

  /**
   * A raw S3 client used by teardown only. Teardown deliberately does not go through the manager
   * under test: if `listObjects` or `deleteObject` is the thing that is broken, the bucket still has
   * to come back empty, or the failing test leaks a bucket instead of reporting a bug.
   */
  const teardownS3 = new S3Client({
    region: "auto",
    endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  });

  /**
   * Empty a bucket so R2 will delete it. Two things hold a bucket: stored objects, and parts of
   * multipart uploads that were never completed or aborted — which is exactly what a test that fails
   * mid-upload leaves behind. Abort those first, then drain every page of keys.
   */
  async function purgeBucket(bucketName: string): Promise<void> {
    const uploads = await teardownS3.send(new ListMultipartUploadsCommand({ Bucket: bucketName }));
    for (const upload of uploads.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue;
      await teardownS3.send(
        new AbortMultipartUploadCommand({ Bucket: bucketName, Key: upload.Key, UploadId: upload.UploadId }),
      );
    }
    let token: string | undefined;
    do {
      const page = await teardownS3.send(new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: token }));
      for (const entry of page.Contents ?? []) {
        if (entry.Key) await teardownS3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: entry.Key }));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  /**
   * Run `exercise` against a manager pointed at a fresh throwaway bucket, then purge and delete it.
   * One bucket per test keeps a failure's debris out of the next test — and out of the account.
   */
  async function withBucket<T>(exercise: (manager: CloudflareR2Manager, bucketName: string) => Promise<T>): Promise<T> {
    return withThrowawayResource(
      () => provisioner.createBucket(uniqueName("pithy-int-r2")),
      (bucket) => exercise(new CloudflareR2Manager({ ...r2Config, bucketName: bucket.name }), bucket.name),
      async (bucket) => {
        // A purge failure would only resurface as a bucket-delete failure; let that be the loud one,
        // so a genuine assertion error is never masked by teardown noise.
        await purgeBucket(bucket.name).catch(() => undefined);
        await provisioner.deleteBucket(bucket.name);
      },
    );
  }

  /** PUT `body` through a freshly presigned whole-object URL. The seeding path for the tests below. */
  async function seed(manager: CloudflareR2Manager, key: string, body: Uint8Array, contentType: string): Promise<void> {
    const url = await manager.createUploadUrl(key, contentType, body.byteLength);
    const put = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body });
    expect(put.ok).toBe(true);
  }

  test("presigns a PUT + GET round-trip against a real bucket, then tears it down", async () => {
    await withBucket(async (manager) => {
      // Happy path: the bucket is reachable over the CF API.
      expect(await manager.validateServiceAccess()).toBe(true);

      // Presign a PUT and upload bytes through it — exercises SigV4 signing against real R2.
      await seed(manager, KEY, BODY, "text/plain");

      // Presign a GET and read it back — the decoded round-trip.
      const downloadUrl = await manager.createDownloadUrl(KEY);
      expect(await (await fetch(downloadUrl)).text()).toBe(PAYLOAD);

      // Error path: a manager pointed at a non-existent bucket fails access validation.
      const missing = new CloudflareR2Manager({ ...r2Config, bucketName: uniqueName("pithy-int-nobucket") });
      expect(await missing.validateServiceAccess()).toBe(false);
    });
  });

  test("moves a multipart upload over presigned part URLs and assembles it with R2's own ETags", async () => {
    await withBucket(async (manager) => {
      const key = "multipart/assembled.bin";
      const uploadId = await manager.createMultipartUpload(key, "application/octet-stream");
      expect(uploadId.length).toBeGreaterThan(0);

      // Two full parts and a short tail. R2 requires every part but the last to be the same size, so
      // the tail must come last — an ordering no mock enforces.
      const bodies = [partBody(0x61, PART_SIZE), partBody(0x62, PART_SIZE), BODY];
      const parts: CompletedPart[] = [];
      for (const [index, body] of bodies.entries()) {
        const partNumber = index + 1;
        const url = await manager.presignUploadPart(key, uploadId, partNumber);
        const put = await fetch(url, { method: "PUT", body });
        expect(put.ok).toBe(true);
        // R2 answers a part PUT with a *quoted* ETag. This is the assertion the whole file exists for:
        // whatever `complete` needs back has to be what a real client can actually read off the wire.
        const etag = put.headers.get("etag") ?? "";
        expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
        parts.push({ partNumber, etag });
      }

      // listParts reports the same parts, in order, with the same quoted ETags — so a resumed upload
      // can complete from a listing alone, without having kept the PUT responses.
      const listed = await manager.listParts(key, uploadId);
      expect(listed.map((part) => part.partNumber)).toEqual([1, 2, 3]);
      expect(listed.map((part) => part.size)).toEqual([PART_SIZE, PART_SIZE, BODY.byteLength]);
      expect(listed.map((part) => part.etag)).toEqual(parts.map((part) => part.etag));

      // Complete with the ETags verbatim — no unquoting, no normalising.
      await manager.completeMultipartUpload(key, uploadId, parts);

      const head = await manager.headObject(key);
      expect(head?.size).toBe(PART_SIZE * 2 + BODY.byteLength);
      expect(head?.contentType).toBe("application/octet-stream");
      expect(head?.uploaded).toBeInstanceOf(Date);
      // A multipart object's ETag carries a `-<partCount>` suffix. R2 assembled three parts, not one.
      expect(head?.etag).toMatch(/^"[0-9a-f]{32}-3"$/);

      // Read the seam between part 1 and part 2 — proof the parts landed in the order we numbered them.
      const downloadUrl = await manager.createDownloadUrl(key);
      const seam = await fetch(downloadUrl, { headers: { range: `bytes=${PART_SIZE - 1}-${PART_SIZE}` } });
      expect(new Uint8Array(await seam.arrayBuffer())).toEqual(new Uint8Array([0x61, 0x62]));
    });
  });

  test("lists the one uploaded part of an in-flight upload, then aborts it twice", async () => {
    await withBucket(async (manager) => {
      const key = "multipart/aborted.bin";
      const uploadId = await manager.createMultipartUpload(key, "application/octet-stream");

      // Pin the part length this time — the opt-in `contentLength` path, signed into the URL.
      const body = partBody(0x63, PART_SIZE);
      const url = await manager.presignUploadPart(key, uploadId, 1, { contentLength: body.byteLength });
      const put = await fetch(url, { method: "PUT", body });
      expect(put.ok).toBe(true);

      // The resume path: exactly the part that landed, with its number, size and ETag.
      const listed = await manager.listParts(key, uploadId);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.partNumber).toBe(1);
      expect(listed[0]?.size).toBe(body.byteLength);
      expect(listed[0]?.etag).toBe(put.headers.get("etag"));

      await manager.abortMultipartUpload(key, uploadId);

      // An aborted upload never becomes an object — the absent path reads as null, not a throw.
      expect(await manager.headObject(key)).toBeNull();

      // Aborting again is a no-op by design, so a retried teardown is safe.
      await expect(manager.abortMultipartUpload(key, uploadId)).resolves.toBeUndefined();

      // But listing a forgotten upload is a real failure, and surfaces as our typed error.
      await expect(manager.listParts(key, uploadId)).rejects.toHaveProperty(
        "payload.code",
        "cloudflare/request_failed",
      );
    });
  });

  test("lists a prefix and pages through it with the returned cursor", async () => {
    await withBucket(async (manager) => {
      const keys = ["page/a", "page/b", "page/c", "page/d", "page/e"];
      for (const key of keys) await seed(manager, key, BODY, "text/plain");
      // A key outside the prefix, so the filter has something to exclude.
      await seed(manager, "other/z", BODY, "text/plain");

      // A small page size forces R2 to truncate and hand back a cursor.
      const first = await manager.listObjects({ prefix: "page/", maxKeys: 2 });
      expect(first.keys).toEqual(["page/a", "page/b"]);
      expect(first.cursor).toBeTruthy();

      // Drain it. The cursor is the only thing that advances the listing; the last page carries none.
      const seen = [...first.keys];
      let cursor = first.cursor;
      let pages = 1;
      while (cursor) {
        const next = await manager.listObjects({ prefix: "page/", maxKeys: 2, cursor });
        seen.push(...next.keys);
        cursor = next.cursor;
        pages += 1;
      }
      expect(seen).toEqual(keys);
      expect(pages).toBe(3);

      // Unfiltered, the whole bucket fits in one page — so no cursor comes back at all.
      const all = await manager.listObjects();
      expect(all.keys).toEqual([...keys, "other/z"].sort());
      expect(all.cursor).toBeUndefined();

      // Absent path: a prefix nothing matches is an empty page, not an error.
      const none = await manager.listObjects({ prefix: "nothing/" });
      expect(none.keys).toEqual([]);
      expect(none.cursor).toBeUndefined();
    });
  });

  test("copies a key that needs encoding, leaves the source, then deletes idempotently", async () => {
    await withBucket(async (manager) => {
      // The space, `&` and `?` are the point: `CopySource` is a header the SDK does not encode, so a
      // key like this is where a wrong encoding produces a malformed source rather than a copy.
      const source = "copy/needs encoding & ?.txt";
      const dest = "copy/dest.txt";
      await seed(manager, source, BODY, "text/plain");

      await manager.copyObject(source, dest);

      const head = await manager.headObject(dest);
      expect(head?.size).toBe(BODY.byteLength);
      expect(head?.contentType).toBe("text/plain");
      expect(await (await fetch(await manager.createDownloadUrl(dest))).text()).toBe(PAYLOAD);

      // A copy is not a move — the source is still there.
      expect(await manager.headObject(source)).not.toBeNull();

      await manager.deleteObject(dest);
      expect(await manager.headObject(dest)).toBeNull();

      // Delete is idempotent by protocol: S3 answers a delete of an absent key with a success.
      await expect(manager.deleteObject(dest)).resolves.toBeUndefined();

      // Error path: copying from a key that does not exist fails as our typed error.
      await expect(manager.copyObject("copy/absent.txt", "copy/never.txt")).rejects.toHaveProperty(
        "payload.code",
        "cloudflare/request_failed",
      );
    });
  });

  test("empties a bucket holding objects and a dangling upload, so R2 will finally delete it", async () => {
    // Not `withBucket`: this test deletes the bucket itself, which is the assertion. Teardown only has
    // to cope with a failure part way through — hence the purge and the idempotent delete below.
    const bucket = await provisioner.createBucket(uniqueName("pithy-int-r2"));
    try {
      const manager = new CloudflareR2Manager({ ...r2Config, bucketName: bucket.name });
      for (const key of ["drain/a", "drain/b", "other/c"]) await seed(manager, key, BODY, "text/plain");

      // A multipart upload started and never completed. Its parts are billed and invisible — `listObjects`
      // does not show it — and R2 refuses to delete a bucket that holds one. This is the half a drain
      // written from a listing alone misses, and the reason the delete below is the real assertion.
      const uploadId = await manager.createMultipartUpload("drain/inflight.bin", "application/octet-stream");
      const partUrl = await manager.presignUploadPart("drain/inflight.bin", uploadId, 1);
      expect((await fetch(partUrl, { method: "PUT", body: partBody(0x64, PART_SIZE) })).ok).toBe(true);

      // Proof the bucket really is undeletable first — otherwise this test would pass without the drain.
      await expect(provisioner.deleteBucket(bucket.name)).rejects.toHaveProperty(
        "payload.code",
        "cloudflare/request_failed",
      );

      expect(await manager.emptyBucket()).toEqual({ objectsDeleted: 3, uploadsAborted: 1 });
      expect((await manager.listObjects()).keys).toEqual([]);
      expect(await manager.listMultipartUploads()).toEqual([]);

      // The whole point: the delete R2 rejected a moment ago now goes through.
      await provisioner.deleteBucket(bucket.name);
      expect(await provisioner.findBucketByName(bucket.name)).toBeNull();

      // And the drain is idempotent on an already-empty bucket, so a retried teardown is safe.
      const fresh = await provisioner.createBucket(uniqueName("pithy-int-r2"));
      const empty = new CloudflareR2Manager({ ...r2Config, bucketName: fresh.name });
      expect(await empty.emptyBucket()).toEqual({ objectsDeleted: 0, uploadsAborted: 0 });
      await provisioner.deleteBucket(fresh.name);
    } finally {
      await purgeBucket(bucket.name).catch(() => undefined);
      await provisioner.deleteBucket(bucket.name);
    }
  });

  test("honours expiresIn on every presigned URL, and defaults to an hour without it", async () => {
    await withBucket(async (manager) => {
      // A short-lived upload URL still works right now — the expiry is a lifetime, not a delay. No
      // sleeping for a real expiry here: that buys one assertion at the cost of a slow, flaky suite.
      const uploadUrl = await manager.createUploadUrl(KEY, "text/plain", BODY.byteLength, { expiresIn: 90 });
      expect(new URL(uploadUrl).searchParams.get("X-Amz-Expires")).toBe("90");
      const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: BODY });
      expect(put.ok).toBe(true);

      const downloadUrl = await manager.createDownloadUrl(KEY, { expiresIn: 45 });
      expect(new URL(downloadUrl).searchParams.get("X-Amz-Expires")).toBe("45");
      expect(await (await fetch(downloadUrl)).text()).toBe(PAYLOAD);

      // Unnamed, the lifetime is one hour.
      expect(new URL(await manager.createDownloadUrl(KEY)).searchParams.get("X-Amz-Expires")).toBe("3600");

      // Part URLs take the same option.
      const key = "expiry/part.bin";
      const uploadId = await manager.createMultipartUpload(key, "application/octet-stream");
      const partUrl = await manager.presignUploadPart(key, uploadId, 1, { expiresIn: 120 });
      expect(new URL(partUrl).searchParams.get("X-Amz-Expires")).toBe("120");
      await manager.abortMultipartUpload(key, uploadId);
    });
  });
});
