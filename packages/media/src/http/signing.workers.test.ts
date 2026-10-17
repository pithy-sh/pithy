// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { caller, fakeStorage, makeDeps, resetMediaTables } from "../test-utils/harness";
import { createMedia, getMedia, mediaDeliveryUrl, updateMedia } from "./handlers";
import type { CreateMediaInput } from "./schemas";
import { signingPending } from "./views";

/**
 * A private record's bytes are private too: a non-public Images or Stream asset is uploaded with
 * `requireSignedURLs` and delivered through a short-lived signed URL. `signedDelivery` is what Cloudflare
 * last confirmed, URL building reads it, and a visibility change that fails halfway says so.
 */

const OWNER = caller("owner", "org-a");
const STRANGER = caller("stranger", "org-b");

const image: CreateMediaInput = { type: "image", name: "p", filename: "p.png", contentType: "image/png", size: 1 };

beforeEach(() => resetMediaTables(env.DB));

function deps(storage = fakeStorage()) {
  return { storage, deps: makeDeps(env.DB, OWNER, { storage }) };
}

describe("upload", () => {
  test("a non-public image is minted requiring signed URLs, and the record says its bytes are signed", async () => {
    const { storage, deps: d } = deps();
    const { id } = await createMedia(d, image);
    expect(storage.calls.minted).toEqual([{ id, signed: true }]);
    expect((await d.store.get(id))?.signedDelivery).toBe(true);
  });

  test("a public image is minted plain", async () => {
    const { storage, deps: d } = deps();
    const { id } = await createMedia(d, { ...image, visibility: "public" });
    expect(storage.calls.minted).toEqual([{ id, signed: false }]);
    expect((await d.store.get(id))?.signedDelivery).toBe(false);
  });

  test("a non-public Stream video is minted requiring signed playback", async () => {
    const storage = fakeStorage("cf-stream");
    const d = makeDeps(env.DB, OWNER, { storage });
    const { id } = await createMedia(d, { type: "video", name: "v", filename: "v.mp4", contentType: "video/mp4" });
    expect(storage.calls.minted).toEqual([{ id, signed: true }]);
  });
});

describe("delivery", () => {
  test("a private image is served by a short-lived signed URL", async () => {
    const { deps: d } = deps();
    const { id } = await createMedia(d, image);
    const url = await mediaDeliveryUrl(d, id, {});
    expect(url.url).toBe(`https://imagedelivery.net/hash/key-${id}/public?exp=${1_700_003_600}&sig=signed`);
    expect(url.expiresAt).toEqual(new Date(1_700_003_600_000));
  });

  test("a public image by its plain URL — to anyone, signed in or not", async () => {
    const { deps: d } = deps();
    const { id } = await createMedia(d, { ...image, visibility: "public" });
    const anonymous = makeDeps(env.DB, caller(null));
    expect(await mediaDeliveryUrl(anonymous, id, { variant: "thumb" })).toEqual({
      url: `https://imagedelivery.net/hash/key-${id}/thumb`,
      expiresAt: null,
    });
  });

  test("a private record's URL is not found for anyone who may not read it", async () => {
    const { deps: d } = deps();
    const { id } = await createMedia(d, image);
    await expect(mediaDeliveryUrl(makeDeps(env.DB, STRANGER), id, {})).rejects.toMatchObject({
      payload: { code: "media/not_found" },
    });
  });

  test("a private R2 object is presigned, never served through a public base", async () => {
    const storage = fakeStorage("r2");
    const d = makeDeps(env.DB, OWNER, { storage });
    const { id } = await createMedia(d, {
      type: "audio",
      name: "a",
      filename: "a.mp3",
      contentType: "audio/mpeg",
      size: 9,
    });
    expect((await mediaDeliveryUrl(d, id, {})).url).toBe(`https://download.example/media/audio/${id}?ttl=3600`);
  });
});

describe("a visibility change, in two systems", () => {
  test("public to private sets Cloudflare first, then both columns", async () => {
    const { storage, deps: d } = deps();
    const { id } = await createMedia(d, { ...image, visibility: "public" });
    const updated = await updateMedia(d, id, { visibility: "private" });
    expect(storage.calls.signing).toEqual([{ storageKey: `key-${id}`, required: true }]);
    expect(updated).toMatchObject({ visibility: "private", signedDelivery: true });
    expect(signingPending(updated)).toBe(false);
  });

  test("public to private with Cloudflare refusing writes nothing — the record is as it was", async () => {
    const { storage, deps: d } = deps();
    const { id } = await createMedia(d, { ...image, visibility: "public" });
    storage.failSigning = true;
    await expect(updateMedia(d, id, { visibility: "private" })).rejects.toThrow("cloudflare refused");
    expect(await d.store.get(id)).toMatchObject({ visibility: "public", signedDelivery: false });
  });

  test("private to public writes visibility, clears Cloudflare, then signedDelivery", async () => {
    const { storage, deps: d } = deps();
    const { id } = await createMedia(d, image);
    const updated = await updateMedia(d, id, { visibility: "public" });
    expect(storage.calls.signing).toEqual([{ storageKey: `key-${id}`, required: false }]);
    expect(updated).toMatchObject({ visibility: "public", signedDelivery: false });
  });

  test("private to public failing halfway is reported as pending, and a retry finishes it", async () => {
    const { storage, deps: d } = deps();
    const { id } = await createMedia(d, image);
    storage.failSigning = true;
    const half = await updateMedia(d, id, { visibility: "public" });
    // Public, with its bytes still signed: readers are handed signed URLs that still work.
    expect(half).toMatchObject({ visibility: "public", signedDelivery: true });
    expect(signingPending(half)).toBe(true);
    expect((await mediaDeliveryUrl(d, id, {})).url).toContain("sig=signed");

    storage.failSigning = false;
    const finished = await updateMedia(d, id, { visibility: "public" });
    expect(finished).toMatchObject({ visibility: "public", signedDelivery: false });
    expect(signingPending(finished)).toBe(false);
  });

  test("an existing record the migration made private is pending, and re-sending private finishes it", async () => {
    const { storage, deps: d } = deps();
    const { id } = await createMedia(d, { ...image, visibility: "public" });
    // What 0003_ownership leaves an existing record as: private, and nothing told Cloudflare.
    await env.DB.prepare("UPDATE pithy_media_assets SET visibility = 'private', signed_delivery = 0 WHERE id = ?")
      .bind(id)
      .run();
    const pending = await getMedia(d, id);
    expect(signingPending(pending)).toBe(true);
    // URL building reads signedDelivery: until Cloudflare is told, the plain URL is the one that works.
    expect((await mediaDeliveryUrl(d, id, {})).url).not.toContain("sig=");

    const finished = await updateMedia(d, id, { visibility: "private" });
    expect(storage.calls.signing).toEqual([{ storageKey: `key-${id}`, required: true }]);
    expect(finished.signedDelivery).toBe(true);
    expect(signingPending(finished)).toBe(false);
  });
});
