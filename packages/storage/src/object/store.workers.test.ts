// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { beforeEach, describe, expect, test } from "vitest";
import { deriveObjectKey } from "./key";
import { objectStore, type PresignedObjects } from "./store";

/**
 * The binding half of the seam, against a real Miniflare R2 bucket — no fakes. Reads, conditional
 * reads, ranges, listing and delete are the paths a Worker actually serves from, so they are proved
 * against the emulator rather than a stub that agrees with our own assumptions.
 *
 * The presign port throws here on purpose: every assertion below must reach R2 through the binding,
 * and a test that accidentally took the S3 path would fail loudly instead of passing quietly.
 */
const noPresign = (): PresignedObjects => {
  throw new Error("the binding surface must never resolve credentials");
};

const secretsEnv = {} as SecretsStoreEnv;
const store = objectStore({ bucket: env.STORAGE_BUCKET, env: secretsEnv, presigned: noPresign });

const body = "the quick brown fox jumps over the lazy dog";
let key: string;

beforeEach(async () => {
  key = deriveObjectKey();
  await env.STORAGE_BUCKET.put(key, body, {
    httpMetadata: { contentType: "text/plain", contentDisposition: 'attachment; filename="fox.txt"' },
  });
});

describe("head and get against real R2", () => {
  test("head reports the stored size, type and disposition without moving bytes", async () => {
    const metadata = await store.head(key);
    expect(metadata?.size).toBe(body.length);
    expect(metadata?.contentType).toBe("text/plain");
    expect(metadata?.contentDisposition).toBe('attachment; filename="fox.txt"');
    expect(metadata?.etag).toMatch(/^[0-9a-f]{32}$/);
  });

  test("get streams the whole body back, and reports no range because none was asked for", async () => {
    const result = await store.get(key);
    expect(result?.body).not.toBe(null);
    expect(await new Response(result?.body as ReadableStream).text()).toBe(body);
    // R2 reports a range on every read. `null` here is the seam's own signal for "the whole object",
    // which is what lets a serve path decide 200 vs 206 without re-deriving it.
    expect(result?.range).toBe(null);
  });

  test("a range read returns only those bytes, while size stays the whole object's", async () => {
    const result = await store.get(key, { range: { offset: 4, length: 5 } });
    expect(await new Response(result?.body as ReadableStream).text()).toBe("quick");
    expect(result?.range).toEqual({ offset: 4, length: 5 });
    expect(result?.metadata.size).toBe(body.length);
  });

  test("a suffix range reads from the end", async () => {
    const result = await store.get(key, { range: { suffix: 3 } });
    expect(await new Response(result?.body as ReadableStream).text()).toBe("dog");
  });

  test("If-None-Match against the current etag yields metadata with no body — the 304 path", async () => {
    const current = await store.head(key);
    const result = await store.get(key, { onlyIf: { etagDoesNotMatch: current?.etag } });
    expect(result).not.toBe(null);
    expect(result?.body).toBe(null);
  });

  test("If-None-Match against a stale etag still serves the bytes", async () => {
    const result = await store.get(key, { onlyIf: { etagDoesNotMatch: "0".repeat(32) } });
    expect(await new Response(result?.body as ReadableStream).text()).toBe(body);
  });

  test("a missing key is null from both head and get", async () => {
    const absent = deriveObjectKey();
    expect(await store.head(absent)).toBe(null);
    expect(await store.get(absent)).toBe(null);
  });
});

describe("list and delete against real R2", () => {
  test("lists by prefix and pages with a cursor only while more remain", async () => {
    const prefix = `obj/list-${crypto.randomUUID()}/`;
    for (let index = 0; index < 3; index += 1) {
      await env.STORAGE_BUCKET.put(`${prefix}${index}`, "x");
    }

    const first = await store.list({ prefix, limit: 2 });
    expect(first.objects).toHaveLength(2);
    expect(first.cursor).toBeTruthy();

    const second = await store.list({ prefix, cursor: first.cursor, limit: 2 });
    expect(second.objects).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
  });

  test("delete removes the object and is idempotent, so a retried teardown is safe", async () => {
    await store.delete(key);
    expect(await store.head(key)).toBe(null);
    await expect(store.delete(key)).resolves.toBeUndefined();
  });
});
