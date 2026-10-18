// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { extendMediaAsset } from "../data/extend";
import { mediaDatabase } from "../data/tables";
import { d1RecordStore } from "../record/d1Store";
import type { MediaRecord } from "../record/store";
import { resetMediaTables } from "../test-utils/harness";
import { storedAssets } from "./assets";

const schema = extendMediaAsset();
const now = new Date(1_700_000_000_000);

function record(id: string, overrides: Partial<MediaRecord>): MediaRecord {
  return {
    id,
    type: "video",
    status: "stored",
    name: `${id} name`,
    filename: `${id}.mp4`,
    contentType: "video/mp4",
    size: 10,
    ownerId: "u-1",
    organizationId: null,
    visibility: "private",
    signedDelivery: true,
    storageBackend: "cf-stream",
    storageKey: `uid-${id}`,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as MediaRecord;
}

beforeEach(() => resetMediaTables(env.DB));

/**
 * The delivery read's half of the join (#728): every asset this environment's own database holds on one
 * Cloudflare product. A management read of the environment, never a caller's listing — so it is a query
 * of its own rather than `RecordStore.list`, which only ever answers what one caller may see.
 */
describe("storedAssets", () => {
  test("answers every stored asset of one type on one backend, whoever owns it, and nothing else", async () => {
    const store = d1RecordStore(mediaDatabase(env.DB, schema), schema);
    await store.create(record("a", { ownerId: "u-1" }));
    await store.create(record("b", { ownerId: "u-2", organizationId: "org-1", visibility: "organization" }));
    await store.create(record("pending", { status: "pending" }));
    await store.create(record("r2", { storageBackend: "r2", storageKey: "media/video/r2" }));
    await store.create(record("image", { type: "image", storageBackend: "cf-images", storageKey: "img-1" }));

    const assets = await storedAssets(mediaDatabase(env.DB))("video", "cf-stream");
    expect(assets.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "a", name: "a name", storageKey: "uid-a" },
      { id: "b", name: "b name", storageKey: "uid-b" },
    ]);
  });

  test("an environment holding none answers none", async () => {
    expect(await storedAssets(mediaDatabase(env.DB))("image", "cf-images")).toEqual([]);
  });
});
