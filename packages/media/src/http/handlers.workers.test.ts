// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { extendMediaAsset } from "../data/extend";
import { mediaDatabase } from "../data/tables";
import { d1RecordStore } from "../record/d1Store";
import { caller, type fakeStorage, makeDeps, resetMediaTables } from "../test-utils/harness";
import { createMedia, deleteMedia, finalizeMedia, getMedia, listMedia, searchDuplicates } from "./handlers";
import type { CreateMediaInput } from "./schemas";

const ALICE = caller("alice", "org-a");

beforeEach(() => resetMediaTables(env.DB));

// The handlers take the already-parsed value the route's `validate("json", CreateMediaInput)` produced,
// so these fixtures are typed as that value rather than as raw literals.
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
    const deps = makeDeps(env.DB, ALICE);
    const result = await createMedia(deps, imageBody);
    expect(result).toMatchObject({ uploadUrl: `https://upload.example/${result.id}`, storageBackend: "cf-images" });
    const record = await deps.store.get(result.id);
    expect(record?.status).toBe("pending");
    expect(record?.sha256).toBe("a".repeat(64));
  });

  test("records its owner and the organization in force", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, imageBody);
    expect(await deps.store.get(id)).toMatchObject({ ownerId: "alice", organizationId: "org-a" });
  });

  test("with no organization in force, records the owner and a null organization", async () => {
    const deps = makeDeps(env.DB, caller("alice"));
    const { id } = await createMedia(deps, imageBody);
    expect(await deps.store.get(id)).toMatchObject({ ownerId: "alice", organizationId: null });
  });

  test("a system-created record records null for both", async () => {
    const deps = makeDeps(env.DB, caller(null));
    const { id } = await createMedia(deps, imageBody);
    expect(await deps.store.get(id)).toMatchObject({ ownerId: null, organizationId: null });
  });

  test("defaults to private", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, imageBody);
    expect((await deps.store.get(id))?.visibility).toBe("private");
  });

  test("keeps a visibility the policy allows", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, { ...imageBody, visibility: "organization" });
    expect((await deps.store.get(id))?.visibility).toBe("organization");
  });

  test("refuses a level outside visibility.allowed, naming the allowed ones — never coerced", async () => {
    const deps = makeDeps(env.DB, ALICE, { config: { visibility: { allowed: ["private", "organization"] } } });
    await expect(createMedia(deps, { ...imageBody, visibility: "public" })).rejects.toMatchObject({
      payload: { code: "validation/invalid_input", message: expect.stringContaining("Allowed: private, organization") },
    });
    // Nothing was minted for the refused write.
    expect((deps.storage as ReturnType<typeof fakeStorage>).calls.minted).toEqual([]);
  });

  test("refuses organization visibility with no organization in force", async () => {
    const deps = makeDeps(env.DB, caller("alice"));
    await expect(createMedia(deps, { ...imageBody, visibility: "organization" })).rejects.toMatchObject({
      payload: { code: "validation/invalid_input" },
    });
  });

  test("persists an adopter extension field and enforces it when required", async () => {
    const extended = extendMediaAsset(z.object({ album: z.string().describe("album") }).describe("ext"));
    await env.DB.exec("ALTER TABLE pithy_media_assets ADD COLUMN album text");
    const deps = makeDeps(env.DB, ALICE, {
      store: d1RecordStore(mediaDatabase(env.DB, extended), extended),
      schema: extended,
    });
    const { id } = await createMedia(deps, { ...imageBody, album: "summer" });
    expect((await deps.store.get(id))?.album).toBe("summer");
    // Missing the required extension field → 400 before anything is stored.
    await expect(createMedia(deps, imageBody)).rejects.toMatchObject({ payload: { status: 400 } });
  });
});

describe("finalizeMedia", () => {
  test("marks the record stored and dispatches enrichment", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, imageBody);
    const record = await finalizeMedia(deps, id, {});
    expect(record.status).toBe("stored");
    expect(deps.dispatched).toEqual([id]);
  });

  test("404s when the record is unknown", async () => {
    await expect(finalizeMedia(makeDeps(env.DB, ALICE), "ghost", {})).rejects.toMatchObject({
      payload: { code: "media/not_found" },
    });
  });
});

describe("getMedia / listMedia / deleteMedia", () => {
  test("get returns the record; 404 on a miss", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, imageBody);
    expect((await getMedia(deps, id)).id).toBe(id);
    await expect(getMedia(deps, "ghost")).rejects.toMatchObject({ payload: { code: "media/not_found" } });
  });

  test("list returns the caller's records", async () => {
    const deps = makeDeps(env.DB, ALICE);
    await createMedia(deps, imageBody);
    await createMedia(deps, imageBody);
    expect((await listMedia(deps, {})).items).toHaveLength(2);
  });

  test("delete removes the record and its object", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, imageBody);
    expect(await deleteMedia(deps, id)).toEqual({ id, deleted: true });
    expect(await deps.store.get(id)).toBeNull();
    expect((deps.storage as ReturnType<typeof fakeStorage>).calls.deleted).toEqual([`key-${id}`]);
  });
});

describe("createMedia — security & validation", () => {
  test("ignores client-supplied server-owned fields (no mass assignment)", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const result = await createMedia(deps, {
      ...imageBody,
      id: "attacker-id",
      status: "stored",
      storageBackend: "r2",
      storageKey: "another-tenants-object",
      hasTranscription: true,
      createdAt: 0,
      ownerId: "mallory",
      organizationId: "org-victim",
      signedDelivery: false,
    });
    expect(result.storageBackend).toBe("cf-images");
    expect(result.storageKey).toBe(`key-${result.id}`);
    const record = await deps.store.get(result.id);
    expect(record).toMatchObject({
      status: "pending",
      storageKey: `key-${result.id}`,
      hasTranscription: false,
      // Whose it is comes from the request, never the body.
      ownerId: "alice",
      organizationId: "org-a",
      signedDelivery: true,
    });
    expect(await deps.store.get("attacker-id")).toBeNull();
  });

  test("requires a size for R2-backed uploads (the presigned PUT signs the length)", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const audio: CreateMediaInput = { type: "audio", name: "clip", filename: "clip.mp3", contentType: "audio/mpeg" };
    await expect(createMedia(deps, audio)).rejects.toMatchObject({ payload: { code: "validation/invalid_input" } });
    const ok = await createMedia(deps, { ...audio, size: 4096 });
    expect(ok.id).toBeTruthy();
  });
});

describe("searchDuplicates", () => {
  test("finds an exact sha256 match after the record is finalized", async () => {
    const deps = makeDeps(env.DB, ALICE);
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
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, imageBody);
    await finalizeMedia(deps, id, {});
    await deleteMedia(deps, id);
    expect((await searchDuplicates(deps, { type: "image", sha256: "a".repeat(64) })).matches).toHaveLength(0);
  });

  test("the hash row carries the record's owner and organization", async () => {
    const deps = makeDeps(env.DB, ALICE);
    const { id } = await createMedia(deps, imageBody);
    await finalizeMedia(deps, id, {});
    const row = await env.DB.prepare("SELECT owner_id, organization_id FROM pithy_media_hashes WHERE media_id = ?")
      .bind(id)
      .first<{ owner_id: string; organization_id: string }>();
    expect(row).toEqual({ owner_id: "alice", organization_id: "org-a" });
  });
});

describe("createMedia — the mediaItems meter (#561)", () => {
  /** How many records the table holds — the authority a refusal must not have moved. */
  async function count(): Promise<number> {
    const row = await env.DB.prepare("select count(*) as n from pithy_media_assets").first<{ n: number }>();
    return row?.n ?? 0;
  }

  test("an enforced ceiling refuses the create past it with payments/quota_exceeded at 402, and writes nothing", async () => {
    const deps = makeDeps(env.DB, ALICE, { itemLimit: async () => 2 });
    await createMedia(deps, imageBody);
    await createMedia(deps, imageBody);
    await expect(createMedia(deps, imageBody)).rejects.toMatchObject({
      payload: { code: "payments/quota_exceeded", status: 402 },
    });
    expect(await count()).toBe(2);
  });

  test("concurrent creates cannot race past the ceiling", async () => {
    const deps = makeDeps(env.DB, ALICE, { itemLimit: async () => 3 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => createMedia(deps, imageBody)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(await count()).toBe(3);
  });

  test("an unrestricted subject — a null ceiling — is never refused", async () => {
    const deps = makeDeps(env.DB, ALICE, { itemLimit: async () => null });
    for (let i = 0; i < 5; i++) await createMedia(deps, imageBody);
    expect(await count()).toBe(5);
  });

  test("an advisory meter, or no provider, limits nothing — existing behavior is unchanged", async () => {
    const advisory = makeDeps(env.DB, ALICE, { itemLimit: async () => undefined });
    for (let i = 0; i < 3; i++) await createMedia(advisory, imageBody);
    const none = makeDeps(env.DB, ALICE);
    await createMedia(none, imageBody);
    expect(await count()).toBe(4);
  });
});
