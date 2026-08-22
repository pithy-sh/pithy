// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { loadIntegrationCreds } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { describe, expect, test } from "vitest";
import { withLiveBucket } from "../test-utils/liveStorage";
import { deriveObjectKey } from "./key";
import { collectParts, MIN_PART_SIZE_BYTES, planMultipart, type ReportedPart } from "./multipart";

/**
 * LIVE integration test — the {@link ObjectStore} seam against a real R2 bucket.
 *
 * This is the half `store.workers.test.ts` cannot reach. Miniflare emulates the R2 *binding*; it
 * serves no S3 endpoint, so a presigned URL has nothing to address there and the entire transfer path
 * the design is built around — bytes going client-to-R2, never through the Worker — is untested until
 * it runs here. Multipart is where a mock lies most: the 5 MiB part floor, the quoting of an ETag, and
 * whether the ETag a client reads off its own PUT response is the one `complete` accepts, are all
 * facts about R2, not about our call shapes.
 *
 * Credentials come from `.dev.vars` (`CLOUDFLARE_*` plus the `R2_CREDENTIALS` key pair) and the store
 * resolves them the production way, through the secrets registry. Skipped without them.
 */
const creds = loadIntegrationCreds();

/** 43 bytes, so a range assertion has something to be wrong about. */
const PAYLOAD = "the quick brown fox jumps over the lazy dog";
const BODY = new TextEncoder().encode(PAYLOAD);

/**
 * Two full 5 MiB parts and a short tail — the smallest upload that is genuinely multipart. Below the
 * floor R2 refuses the completion, which is the constraint worth paying 10 MiB of bandwidth to prove.
 */
const MULTIPART_SIZE = MIN_PART_SIZE_BYTES * 2 + BODY.byteLength;

/** A part body of `size` bytes, every byte `filler`. Distinct fillers make the assembled seam visible. */
function partBody(filler: number, size: number): Uint8Array {
  return new Uint8Array(size).fill(filler);
}

describe.skipIf(!creds.hasCreds || !creds.r2)("ObjectStore — LIVE against real R2", () => {
  // Clean up whatever a previous aborted run orphaned before creating anything new.
  // Stale buckets and databases are reclaimed once per run by `globalSetup`, not here — a `beforeAll`
  // inside a `describe.skipIf` never runs when the suite skips. See `@pithy-sh/cloudflare`'s
  // `src/test-utils/reap.ts`.

  test("presigns a PUT from the resolved credential bundle, moves real bytes, and reads them back", async () => {
    await withLiveBucket(creds, async ({ store }) => {
      const key = deriveObjectKey();

      // Reaching R2 at all proves the whole credential path: the registry declared the name, the
      // secrets reader resolved the injected bundle, and Zod validated it before anything was signed.
      const url = await store.presignPut(key, "text/plain", BODY.byteLength);
      const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
      // The asymmetry the completion path exists to reconcile, visible in the URL itself: the byte
      // count is signed, the content type is not — the presigner marks it unsignable before signing.
      expect(signed).toContain("content-length");
      expect(signed).not.toContain("content-type");

      const put = await fetch(url, { method: "PUT", headers: { "content-type": "text/plain" }, body: BODY });
      expect(put.ok).toBe(true);

      // The decoded response shape: R2's own metadata, through the seam's Zod object.
      const metadata = await store.head(key);
      expect(metadata?.key).toBe(key);
      expect(metadata?.size).toBe(BODY.byteLength);
      expect(metadata?.contentType).toBe("text/plain");
      expect(metadata?.etag).toMatch(/^[0-9a-f]{32}$/);
      expect(metadata?.uploaded).toBeInstanceOf(Date);

      // Read the bytes back the way a client does — a presigned GET, no Worker in the byte path.
      const download = await fetch(await store.presignGet(key));
      expect(await download.text()).toBe(PAYLOAD);

      // Absent path: a key nothing ever wrote is null, not a throw.
      expect(await store.head(deriveObjectKey())).toBeNull();
    });
  });

  test("runs a multipart upload through the seam and assembles it with the ETags R2 handed back", async () => {
    await withLiveBucket(creds, async ({ store }) => {
      const key = deriveObjectKey();
      const uploadId = await store.initMultipart(key, "application/octet-stream");
      expect(uploadId.length).toBeGreaterThan(0);

      // The plan the handler would build for this size, at R2's own part floor.
      const plan = planMultipart(MULTIPART_SIZE, MIN_PART_SIZE_BYTES);
      expect(plan.partCount).toBe(3);

      const reported: ReportedPart[] = [];
      for (const part of plan.parts) {
        const body = part.partNumber === plan.partCount ? BODY : partBody(0x60 + part.partNumber, part.length);
        expect(body.byteLength).toBe(part.length);
        const url = await store.presignPart(key, uploadId, part.partNumber);
        const put = await fetch(url, { method: "PUT", body });
        expect(put.ok).toBe(true);
        // R2 answers a part PUT with a *quoted* ETag. Reported verbatim, quotes included — the seam
        // never normalizes it, and R2 compares it byte for byte at completion.
        const etag = put.headers.get("etag") ?? "";
        expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
        reported.push({ partNumber: part.partNumber, etag });
      }

      // The resume path: what R2 holds, decoded through the seam's own schema. A client that lost its
      // PUT responses can complete from this listing alone.
      const uploaded = await store.listParts(key, uploadId);
      expect(uploaded.map((part) => part.partNumber)).toEqual([1, 2, 3]);
      expect(uploaded.map((part) => part.size)).toEqual(plan.parts.map((part) => part.length));
      expect(uploaded.map((part) => part.etag)).toEqual(reported.map((part) => part.etag));

      await store.completeMultipart(key, uploadId, collectParts(reported, plan.partCount));

      const metadata = await store.head(key);
      expect(metadata?.size).toBe(MULTIPART_SIZE);
      // Unlike a presigned PUT, opening a multipart upload is a server-side call — so this type R2
      // really did store, and the row that records it needs no reconciling.
      expect(metadata?.contentType).toBe("application/octet-stream");
      // A multipart ETag carries a `-<partCount>` suffix: R2 assembled three parts, not one blob.
      expect(metadata?.etag).toMatch(/^[0-9a-f]{32}-3$/);

      // The seam between part 1 and part 2 — proof the parts landed in the order we numbered them.
      const seam = await fetch(await store.presignGet(key), {
        headers: { range: `bytes=${MIN_PART_SIZE_BYTES - 1}-${MIN_PART_SIZE_BYTES}` },
      });
      expect(new Uint8Array(await seam.arrayBuffer())).toEqual(new Uint8Array([0x61, 0x62]));
    });
  });

  test("aborts an in-flight upload, leaves no object behind, and stays idempotent", async () => {
    await withLiveBucket(creds, async ({ store, manager }) => {
      const key = deriveObjectKey();
      const uploadId = await store.initMultipart(key, "application/octet-stream");
      const url = await store.presignPart(key, uploadId, 1);
      expect((await fetch(url, { method: "PUT", body: partBody(0x63, MIN_PART_SIZE_BYTES) })).ok).toBe(true);
      expect(await store.listParts(key, uploadId)).toHaveLength(1);

      await store.abortMultipart(key, uploadId);

      // An aborted upload never becomes an object, and its parts stop costing money.
      expect(await store.head(key)).toBeNull();
      // Idempotent by design, so a sweep or a retried teardown can re-run without a special case.
      await expect(store.abortMultipart(key, uploadId)).resolves.toBeUndefined();
      // But an upload id R2 has forgotten cannot be listed — the error path a resume must handle.
      await expect(manager.listParts(key, uploadId)).rejects.toHaveProperty(
        "payload.code",
        "cloudflare/request_failed",
      );
    });
  });

  test("serves ranges and honors conditional reads exactly as R2 defines them", async () => {
    await withLiveBucket(creds, async ({ store }) => {
      const key = deriveObjectKey();
      const put = await fetch(await store.presignPut(key, "text/plain", BODY.byteLength), {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: BODY,
      });
      expect(put.ok).toBe(true);

      const metadata = await store.head(key);
      const etag = `"${metadata?.etag}"`;
      const url = await store.presignGet(key);

      // A byte range is 206 with a `Content-Range` naming the whole object's size — the answer a serve
      // path echoes, and the one a fake gets subtly wrong.
      const range = await fetch(url, { headers: { range: "bytes=4-8" } });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toBe(`bytes 4-8/${BODY.byteLength}`);
      expect(await range.text()).toBe("quick");

      // A suffix range reads from the end.
      const suffix = await fetch(url, { headers: { range: "bytes=-3" } });
      expect(suffix.status).toBe(206);
      expect(await suffix.text()).toBe("dog");

      // If-None-Match against the current ETag: 304, no body. This is what the binding's `onlyIf`
      // compiles down to, and the only place its semantics come from R2 rather than from an emulator.
      const notModified = await fetch(url, { headers: { "if-none-match": etag } });
      expect(notModified.status).toBe(304);
      expect(await notModified.text()).toBe("");

      // A stale ETag still serves the bytes.
      const stale = await fetch(url, { headers: { "if-none-match": `"${"0".repeat(32)}"` } });
      expect(stale.status).toBe(200);
      expect(await stale.text()).toBe(PAYLOAD);

      // If-Match is the other direction: the current ETag passes, a mismatch is 412 — a failed
      // precondition, not a miss. Nothing but R2 can confirm it does not answer 404 here.
      expect((await fetch(url, { headers: { "if-match": etag } })).status).toBe(200);
      const precondition = await fetch(url, { headers: { "if-match": `"${"0".repeat(32)}"` } });
      expect(precondition.status).toBe(412);
    });
  });

  test("copies server-side and deletes idempotently", async () => {
    await withLiveBucket(creds, async ({ store }) => {
      const source = deriveObjectKey();
      const destination = deriveObjectKey();
      const put = await fetch(await store.presignPut(source, "text/plain", BODY.byteLength), {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: BODY,
      });
      expect(put.ok).toBe(true);

      await store.copy(source, destination);

      // The bytes never entered this process — R2 copied them, and the type came with them.
      const copied = await store.head(destination);
      expect(copied?.size).toBe(BODY.byteLength);
      expect(copied?.contentType).toBe("text/plain");
      expect(await (await fetch(await store.presignGet(destination))).text()).toBe(PAYLOAD);
      // A copy is not a move.
      expect(await store.head(source)).not.toBeNull();

      await store.delete(destination);
      expect(await store.head(destination)).toBeNull();
      // Idempotent by protocol: deleting an absent key is a success, so teardown can re-run.
      await expect(store.delete(destination)).resolves.toBeUndefined();
    });
  });
});
