// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { readablePredicate } from "@pithy-sh/core/src/access/access";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { extendMediaAsset } from "../data/extend";
import { mediaDatabase } from "../data/tables";
import { caller, resetMediaTables } from "../test-utils/harness";
import { d1RecordStore } from "./d1Store";
import type { MediaRecord, RecordStore } from "./store";

const schema = extendMediaAsset();

function makeRecord(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id: "m1",
    type: "image",
    status: "pending",
    name: "photo",
    filename: "a.png",
    contentType: "image/png",
    size: 10,
    ownerId: "u-1",
    organizationId: null,
    visibility: "private",
    signedDelivery: true,
    storageBackend: "cf-images",
    storageKey: "img-1",
    sha256: null,
    phash: null,
    width: null,
    height: null,
    altText: null,
    caption: null,
    transcription: null,
    hasTranscription: false,
    extractedText: null,
    hasExtractedText: false,
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_000_000),
    ...overrides,
  } as MediaRecord;
}

/** Everything the owner `u-1` may see while no organization is in force — every fixture record. */
const OWNERS = readablePredicate(caller("u-1"), { managePower: "media:manage" });

/** The record store's behavioral contract, against a real D1. */
function storeContract(name: string, make: () => RecordStore): void {
  describe(`RecordStore — ${name}`, () => {
    beforeEach(() => resetMediaTables(env.DB));

    test("create then get round-trips, with codecs (Date, boolean) preserved", async () => {
      const store = make();
      await store.create(makeRecord({ createdAt: new Date(1_700_000_000_000), hasTranscription: false }));
      const read = await store.get("m1");
      expect(read?.name).toBe("photo");
      expect(read?.createdAt).toBeInstanceOf(Date);
      expect(read?.createdAt.getTime()).toBe(1_700_000_000_000);
      expect(read?.hasTranscription).toBe(false);
    });

    test("get returns null on a miss", async () => {
      expect(await make().get("nope")).toBeNull();
    });

    test("patch merges changes and re-validates", async () => {
      const store = make();
      await store.create(makeRecord());
      const updated = await store.patch("m1", { status: "stored", transcription: "hello", hasTranscription: true });
      expect(updated.status).toBe("stored");
      expect(updated.transcription).toBe("hello");
      expect((await store.get("m1"))?.hasTranscription).toBe(true);
    });

    test("patch on an unknown id throws media/not_found", async () => {
      await expect(make().patch("ghost", { status: "stored" })).rejects.toMatchObject({
        payload: { code: "media/not_found" },
      });
    });

    test("delete removes the record", async () => {
      const store = make();
      await store.create(makeRecord());
      await store.delete("m1");
      expect(await store.get("m1")).toBeNull();
    });

    test("list returns records newest-first and filters by type", async () => {
      const store = make();
      await store.create(makeRecord({ id: "a", type: "image", createdAt: new Date(1000) }));
      await store.create(
        makeRecord({
          id: "b",
          type: "audio",
          storageBackend: "r2",
          storageKey: "media/audio/b",
          createdAt: new Date(2000),
        }),
      );
      const all = await store.list({ readable: OWNERS });
      expect(all.items.map((r) => r.id)).toEqual(["b", "a"]);
      const images = await store.list({ readable: OWNERS, type: "image" });
      expect(images.items.map((r) => r.id)).toEqual(["a"]);
    });

    test("an adopter extension field round-trips", async () => {
      // Build a store bound to an extended schema — the store validates and persists the extra field.
      const extended = extendMediaAsset(z.object({ album: z.string().describe("album") }).describe("ext"));
      await env.DB.exec("ALTER TABLE pithy_media_assets ADD COLUMN album text");
      const store = d1RecordStore(mediaDatabase(env.DB, extended), extended);
      await store.create(makeRecord({ album: "summer" }));
      expect((await store.get("m1"))?.album).toBe("summer");
    });

    test("the owner, organization, visibility and signing round-trip", async () => {
      const store = make();
      await store.create(
        makeRecord({ ownerId: "u-1", organizationId: "org-a", visibility: "organization", signedDelivery: true }),
      );
      expect(await store.get("m1")).toMatchObject({
        ownerId: "u-1",
        organizationId: "org-a",
        visibility: "organization",
        signedDelivery: true,
      });
    });

    test("list reads only what the predicate admits — there is no unscoped list", async () => {
      const store = make();
      await store.create(makeRecord({ id: "mine" }));
      await store.create(makeRecord({ id: "theirs", ownerId: "u-2" }));
      const page = await store.list({ readable: OWNERS });
      expect(page.items.map((r) => r.id)).toEqual(["mine"]);
    });
  });
}

storeContract("D1", () => d1RecordStore(mediaDatabase(env.DB, schema), schema));

test("D1: an omitted optional extension field round-trips as null (no 500 on read)", async () => {
  await resetMediaTables(env.DB);
  // A plain `.optional()` field — the effective schema widens it to accept the NULL SQLite returns.
  const extended = extendMediaAsset(z.object({ tag: z.string().optional().describe("A tag.") }).describe("ext"));
  await env.DB.exec("ALTER TABLE pithy_media_assets ADD COLUMN tag text");
  const store = d1RecordStore(mediaDatabase(env.DB, extended), extended);
  await store.create(makeRecord()); // no `tag` → the column is NULL
  const read = await store.get("m1"); // must not throw on the NULL
  expect(read?.name).toBe("photo");
  expect(read?.tag ?? null).toBeNull();
});
