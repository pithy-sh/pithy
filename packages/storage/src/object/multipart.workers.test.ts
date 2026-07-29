import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { deriveObjectKey } from "./key";
import { collectParts, MIN_PART_SIZE_BYTES, planMultipart, type ReportedPart } from "./multipart";

/**
 * The part plan and the ETag collection, driven against a real Miniflare R2 multipart upload.
 *
 * Miniflare emulates R2 through the **binding**, not the S3 HTTP protocol, so the *presigned* part
 * URLs `ObjectStore` mints cannot be exercised here — that path is covered by
 * `*.integration.test.ts` against a live bucket. What can be proved here is the part that actually
 * carries risk: that a plan `planMultipart` produced decomposes an object R2 will reassemble byte for
 * byte, that `collectParts` hands back a list R2 accepts, and that an abort really discards the
 * upload. Those are the same calls a presigned upload makes, with the transport swapped.
 */

/** Deterministic filler — `crypto.getRandomValues` caps at 64 KiB, and randomness proves nothing here. */
function bytes(length: number, seed: number): Uint8Array {
  const data = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) data[index] = (index + seed) % 251;
  return data;
}

/**
 * Compare multi-megabyte payloads by digest, never by deep equality. A `toEqual` over ten million
 * typed-array elements builds a diff large enough to exhaust the runtime's heap — the assertion kills
 * the worker before it can fail.
 */
async function digest(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", data as ArrayBuffer);
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PART_SIZE = MIN_PART_SIZE_BYTES;
const SIZE = 2 * PART_SIZE + 1024;

describe("a planned multipart upload against real R2", () => {
  test("R2 reassembles the object exactly as the plan decomposed it", async () => {
    const key = deriveObjectKey();
    const plan = planMultipart(SIZE, PART_SIZE);
    expect(plan.partCount).toBe(3);
    // Only the final part is allowed to fall under the 5 MiB floor.
    expect(plan.parts.map((part) => part.length)).toEqual([PART_SIZE, PART_SIZE, 1024]);

    const data = bytes(SIZE, 7);
    const upload = await env.STORAGE_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    // Report the parts back out of order, the way concurrent PUTs finish.
    const reported: ReportedPart[] = [];
    for (const part of [...plan.parts].reverse()) {
      const slice = data.slice(part.offset, part.offset + part.length);
      const uploaded = await upload.uploadPart(part.partNumber, slice);
      reported.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    }
    expect(reported.map((part) => part.partNumber)).toEqual([3, 2, 1]);

    await upload.complete(collectParts(reported, plan.partCount));

    const stored = await env.STORAGE_BUCKET.get(key);
    expect(stored?.size).toBe(SIZE);
    expect(await digest(await (stored as R2ObjectBody).arrayBuffer())).toBe(await digest(data));
    await env.STORAGE_BUCKET.delete(key);
  });

  test("a resumed upload sees the parts already stored, so a dead client re-sends only the rest", async () => {
    const key = deriveObjectKey();
    const plan = planMultipart(SIZE, PART_SIZE);
    const data = bytes(SIZE, 11);

    const upload = await env.STORAGE_BUCKET.createMultipartUpload(key);
    const first = plan.parts[0];
    if (!first) throw new Error("plan has no parts");
    const uploaded = await upload.uploadPart(first.partNumber, data.slice(first.offset, first.offset + first.length));

    // The client dies here and comes back with only the key and the upload id.
    const resumed = env.STORAGE_BUCKET.resumeMultipartUpload(key, upload.uploadId);
    const reported: ReportedPart[] = [{ partNumber: uploaded.partNumber, etag: uploaded.etag }];
    for (const part of plan.parts.slice(1)) {
      const rest = await resumed.uploadPart(part.partNumber, data.slice(part.offset, part.offset + part.length));
      reported.push({ partNumber: rest.partNumber, etag: rest.etag });
    }

    await resumed.complete(collectParts(reported, plan.partCount));
    expect((await env.STORAGE_BUCKET.head(key))?.size).toBe(SIZE);
    await env.STORAGE_BUCKET.delete(key);
  });

  test("abort discards the upload, and no object is left behind", async () => {
    const key = deriveObjectKey();
    const plan = planMultipart(SIZE, PART_SIZE);
    const data = bytes(SIZE, 13);

    const upload = await env.STORAGE_BUCKET.createMultipartUpload(key);
    const first = plan.parts[0];
    if (!first) throw new Error("plan has no parts");
    await upload.uploadPart(first.partNumber, data.slice(first.offset, first.offset + first.length));
    await upload.abort();

    expect(await env.STORAGE_BUCKET.head(key)).toBe(null);
    // Completing an aborted upload must fail — the parts are gone, not merely unreferenced.
    await expect(upload.complete([{ partNumber: 1, etag: "whatever" }])).rejects.toThrow();
  });

  test("collectParts refuses a gap before R2 ever sees it", async () => {
    const key = deriveObjectKey();
    const plan = planMultipart(SIZE, PART_SIZE);
    const data = bytes(SIZE, 17);

    const upload = await env.STORAGE_BUCKET.createMultipartUpload(key);
    const first = plan.parts[0];
    if (!first) throw new Error("plan has no parts");
    const uploaded = await upload.uploadPart(first.partNumber, data.slice(first.offset, first.offset + first.length));

    expect(() => collectParts([{ partNumber: 1, etag: uploaded.etag }], plan.partCount)).toThrowError(/missing parts/i);
    await upload.abort();
  });
});
