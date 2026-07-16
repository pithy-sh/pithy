import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { extendMediaAsset } from "../data/extend";
import { MediaAsset } from "../data/mediaAsset";
import { mediaDatabase } from "../data/tables";
import { media_0002_assets } from "../migrations/0002_assets";
import { d1RecordStore } from "./d1Store";
import { kvRecordStore } from "./kvStore";
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

/** Reset D1: drop and recreate the media table via the migration's `up`. */
async function resetD1(): Promise<void> {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_media_assets");
  await media_0002_assets.up(mediaDatabase(env.DB) as unknown as Parameters<typeof media_0002_assets.up>[0]);
}

/** Reset KV: delete every key. */
async function resetKv(): Promise<void> {
  const { keys } = await env.MEDIA.list();
  await Promise.all(keys.map((key) => env.MEDIA.delete(key.name)));
}

/** The behavioural contract both stores satisfy — run once per backend. */
function storeContract(name: string, make: () => RecordStore, reset: () => Promise<void>): void {
  describe(`RecordStore — ${name}`, () => {
    beforeEach(reset);

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
      const all = await store.list();
      expect(all.items.map((r) => r.id)).toEqual(["b", "a"]);
      const images = await store.list({ type: "image" });
      expect(images.items.map((r) => r.id)).toEqual(["a"]);
    });

    test("an adopter extension field round-trips", async () => {
      // Build a store bound to an extended schema — the store validates and persists the extra field.
      const extended = extendMediaAsset(z.object({ userId: z.string().describe("owner") }).describe("ext"));
      // D1 needs the real column; KV needs nothing (the value is validated whole).
      if (name === "D1") await env.DB.exec("ALTER TABLE pithy_media_assets ADD COLUMN user_id text");
      const store =
        name === "D1" ? d1RecordStore(mediaDatabase(env.DB, extended), extended) : kvRecordStore(env.MEDIA, extended);
      await store.create(makeRecord({ userId: "u-7" }));
      expect((await store.get("m1"))?.userId).toBe("u-7");
    });
  });
}

storeContract("D1", () => d1RecordStore(mediaDatabase(env.DB, schema), schema), resetD1);
storeContract("KV", () => kvRecordStore(env.MEDIA, schema), resetKv);

test("D1: an omitted optional extension field round-trips as null (no 500 on read)", async () => {
  await resetD1();
  // A plain `.optional()` field — the effective schema widens it to accept the NULL SQLite returns.
  const extended = extendMediaAsset(z.object({ tag: z.string().optional().describe("A tag.") }).describe("ext"));
  await env.DB.exec("ALTER TABLE pithy_media_assets ADD COLUMN tag text");
  const store = d1RecordStore(mediaDatabase(env.DB, extended), extended);
  await store.create(makeRecord()); // no `tag` → the column is NULL
  const read = await store.get("m1"); // must not throw on the NULL
  expect(read?.name).toBe("photo");
  expect(read?.tag ?? null).toBeNull();
});

test("KV: kvMetadata fields (including an adopter field) ride on the list-time metadata", async () => {
  await resetKv();
  const extended = extendMediaAsset(z.object({ userId: z.string().describe("owner") }).describe("ext"));
  // Ask for `status` and the adopter's `userId` as metadata (type + createdAt are always included).
  const store = kvRecordStore(env.MEDIA, extended, ["status", "userId"]);
  await store.create(makeRecord({ id: "a", type: "image", userId: "u-1" }));

  // The metadata is on the raw KV `list` — visible without reading the value.
  const listed = await env.MEDIA.list();
  const entry = listed.keys.find((k) => k.name === "media:a");
  expect(entry?.metadata).toMatchObject({ type: "image", status: "pending", userId: "u-1" });

  // The store's `list` still returns the full record.
  const page = await store.list();
  expect(page.items[0]?.userId).toBe("u-1");
});

test("KV: an extension metadata field survives a patch under the worker's passthrough schema", async () => {
  await resetKv();
  // The enrichment worker builds its store from a passthrough schema whose `shape` lacks the extension
  // field. Metadata is derived by name from the value, so `userId` must still ride along after a patch.
  const passthrough = MediaAsset.catchall(z.unknown());
  const store = kvRecordStore(env.MEDIA, passthrough, ["userId"]);
  await store.create(makeRecord({ id: "a", type: "image", userId: "u-1" }));
  // Simulate an enrichment write-back (patch a derived field).
  await store.patch("a", { altText: "a cat", hasTranscription: false });

  const entry = (await env.MEDIA.list()).keys.find((k) => k.name === "media:a");
  expect(entry?.metadata).toMatchObject({ userId: "u-1", type: "image" });
});
