import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MediaConfig } from "../config/config";
import { extendMediaAsset } from "../data/extend";
import { mediaDatabase } from "../data/tables";
import { media_0001_hashes } from "../migrations/0001_hashes";
import { media_0002_assets } from "../migrations/0002_assets";
import { d1RecordStore } from "../record/d1Store";
import { d1HashStore } from "../record/hashStore";
import type { MediaStorage } from "../storage/storage";
import {
  createMedia,
  deleteMedia,
  finalizeMedia,
  getMedia,
  type HandlerDeps,
  listMedia,
  searchDuplicates,
} from "./handlers";
import type { CreateMediaInput } from "./schemas";

const schema = extendMediaAsset();

/** A fake storage seam that records mint calls and never touches Cloudflare. */
function fakeStorage(): MediaStorage & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    mintUpload: async (params) => ({
      uploadUrl: `https://upload.example/${params.id}`,
      storageBackend: "cf-images",
      storageKey: `key-${params.id}`,
    }),
    deleteObject: async (location) => {
      deleted.push(location.storageKey);
    },
    readR2Object: async () => new Uint8Array(),
    presignedDownloadUrl: async (location) => `https://download.example/${location.storageKey}`,
  };
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps & { dispatched: string[] } {
  const dispatched: string[] = [];
  let counter = 0;
  const deps: HandlerDeps = {
    store: d1RecordStore(mediaDatabase(env.DB, schema), schema),
    hashes: d1HashStore(env.DB, () => new Date(1_700_000_000_000)),
    storage: fakeStorage(),
    schema,
    config: MediaConfig.parse({ images: { imageToText: true } }),
    dispatchEnrichment: async (record) => {
      dispatched.push(String(record.id));
    },
    newId: () => `id-${++counter}`,
    now: () => new Date(1_700_000_000_000),
    ...overrides,
  };
  return Object.assign(deps, { dispatched });
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_media_assets");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_media_hashes");
  await media_0001_hashes.up(mediaDatabase(env.DB) as unknown as Parameters<typeof media_0001_hashes.up>[0]);
  await media_0002_assets.up(mediaDatabase(env.DB) as unknown as Parameters<typeof media_0002_assets.up>[0]);
});

// The handlers now take the already-parsed value the route's `zValidator("json", CreateMediaInput, …)`
// produced, so these fixtures are typed as that value rather than as raw literals.
const imageBody: CreateMediaInput = {
  type: "image",
  name: "A photo",
  filename: "a.png",
  contentType: "image/png",
  size: 2048,
  sha256: "a".repeat(64),
  phash: "0f0f0f0f0f0f0f0f",
  width: 800,
  height: 600,
};

describe("createMedia", () => {
  test("mints an upload URL and creates a pending record", async () => {
    const deps = makeDeps();
    const result = await createMedia(deps, imageBody);
    expect(result).toMatchObject({ id: "id-1", uploadUrl: "https://upload.example/id-1", storageBackend: "cf-images" });
    const record = await deps.store.get("id-1");
    expect(record?.status).toBe("pending");
    expect(record?.sha256).toBe("a".repeat(64));
  });

  // Body shape is no longer this handler's job — a bad `type` is rejected by the route's
  // `zValidator("json", CreateMediaInput, validationHook)` before the handler runs. That assertion now
  // lives in routes.workers.test.ts ("a malformed body is a 400 …").

  test("persists an adopter extension field and enforces it when required", async () => {
    const extended = extendMediaAsset(z.object({ userId: z.string().describe("owner") }).describe("ext"));
    await env.DB.exec("ALTER TABLE pithy_media_assets ADD COLUMN user_id text");
    const deps = makeDeps({ store: d1RecordStore(mediaDatabase(env.DB, extended), extended), schema: extended });
    await createMedia(deps, { ...imageBody, userId: "u-1" });
    expect((await deps.store.get("id-1"))?.userId).toBe("u-1");
    // Missing the required extension field → 400 before anything is stored.
    await expect(createMedia(deps, imageBody)).rejects.toMatchObject({ payload: { status: 400 } });
  });
});

describe("finalizeMedia", () => {
  test("marks the record stored and dispatches enrichment", async () => {
    const deps = makeDeps();
    const { id } = await createMedia(deps, imageBody);
    const record = await finalizeMedia(deps, id, {});
    expect(record.status).toBe("stored");
    expect(deps.dispatched).toEqual([id]);
  });

  test("404s when the record is unknown", async () => {
    await expect(finalizeMedia(makeDeps(), "ghost", {})).rejects.toMatchObject({
      payload: { code: "media/not_found" },
    });
  });
});

describe("getMedia / listMedia / deleteMedia", () => {
  test("get returns the record; 404 on a miss", async () => {
    const deps = makeDeps();
    const { id } = await createMedia(deps, imageBody);
    expect((await getMedia(deps, id)).id).toBe(id);
    await expect(getMedia(deps, "ghost")).rejects.toMatchObject({ payload: { code: "media/not_found" } });
  });

  test("list returns created records", async () => {
    const deps = makeDeps();
    await createMedia(deps, imageBody);
    await createMedia(deps, imageBody);
    const page = await listMedia(deps, {});
    expect(page.items).toHaveLength(2);
  });

  test("delete removes the record and its object", async () => {
    const deps = makeDeps();
    const { id } = await createMedia(deps, imageBody);
    const result = await deleteMedia(deps, id);
    expect(result).toEqual({ id, deleted: true });
    expect(await deps.store.get(id)).toBeNull();
    expect((deps.storage as ReturnType<typeof fakeStorage>).deleted).toEqual([`key-${id}`]);
  });
});

describe("createMedia — security & validation", () => {
  test("ignores client-supplied server-owned fields (no mass assignment)", async () => {
    const deps = makeDeps();
    const result = await createMedia(deps, {
      ...imageBody,
      id: "attacker-id",
      status: "stored",
      storageBackend: "r2",
      storageKey: "another-tenants-object",
      hasTranscription: true,
      createdAt: 0,
    });
    // The id is minted, the status is pending, and the storage coordinates come from the mint — never the body.
    expect(result.id).toBe("id-1");
    expect(result.storageBackend).toBe("cf-images");
    expect(result.storageKey).toBe("key-id-1");
    const record = await deps.store.get("id-1");
    expect(record?.status).toBe("pending");
    expect(record?.storageKey).toBe("key-id-1");
    expect(record?.hasTranscription).toBe(false);
    // The forged id never became a record.
    expect(await deps.store.get("attacker-id")).toBeNull();
  });

  test("requires a size for R2-backed uploads (the presigned PUT signs the length)", async () => {
    const deps = makeDeps();
    // Not a Zod failure: a well-formed body whose size requirement depends on the resolved backend.
    // The schema cannot express it, so it stays a hand-thrown ValidationError inside the handler.
    const audio: CreateMediaInput = { type: "audio", name: "clip", filename: "clip.mp3", contentType: "audio/mpeg" };
    await expect(createMedia(deps, audio)).rejects.toMatchObject({ payload: { code: "validation/invalid_input" } });
    // With a size it succeeds.
    const ok = await createMedia(deps, { ...audio, size: 4096 });
    expect(ok.id).toBe("id-1");
  });
});

describe("searchDuplicates", () => {
  test("finds an exact sha256 match after the record is finalized", async () => {
    const deps = makeDeps();
    const { id } = await createMedia(deps, imageBody);
    // No hash yet — dedup is written on finalize, so a pre-finalize search finds nothing.
    expect((await searchDuplicates(deps, { type: "image", sha256: "a".repeat(64) })).matches).toHaveLength(0);
    await finalizeMedia(deps, id, {});
    const { matches } = await searchDuplicates(deps, { type: "image", sha256: "a".repeat(64) });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id, kind: "identical", distance: 0 });
    expect(matches[0]?.record.id).toBe(id);
  });

  test("delete removes the record's dedup hash", async () => {
    const deps = makeDeps();
    const { id } = await createMedia(deps, imageBody);
    await finalizeMedia(deps, id, {});
    await deleteMedia(deps, id);
    expect((await searchDuplicates(deps, { type: "image", sha256: "a".repeat(64) })).matches).toHaveLength(0);
  });
});
