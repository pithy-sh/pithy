// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MEDIA_MIGRATION_ORDER } from "../capability";
import { extendMediaAsset, extensionColumns } from "../data/extend";
import { mediaDatabase } from "../data/tables";
import { d1RecordStore } from "../record/d1Store";
import type { MediaRecord } from "../record/store";
import { media_0001_init } from "./0001_init";
import { media_0003_ownership } from "./0003_ownership";
import { mediaExtendMigration } from "./extend";

function makeRecord(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id: "m1",
    type: "image",
    status: "stored",
    name: "A photo",
    filename: "a.png",
    contentType: "image/png",
    size: 1024,
    ownerId: "u-1",
    organizationId: "org-a",
    visibility: "private",
    signedDelivery: true,
    storageBackend: "cf-images",
    storageKey: "img-1",
    sha256: "a".repeat(64),
    phash: "0f0f0f0f0f0f0f0f",
    width: 800,
    height: 600,
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

/**
 * The key `createMigrationRegistry` composes for one of media's local migrations —
 * `0350_media_0001_init`. Derived from {@link MEDIA_MIGRATION_ORDER} rather than written out, so
 * renumbering the capability cannot leave a test asserting a key the registry no longer produces.
 */
function composedKey(localKey: string): string {
  return `${String(MEDIA_MIGRATION_ORDER).padStart(4, "0")}_media_${localKey}`;
}

/** Build an app-database provider for the given local migration set. */
function provider(migrations: Record<string, Migration>): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "media", order: MEDIA_MIGRATION_ORDER, migrations },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pithy_media_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

beforeEach(async () => {
  for (const t of ["pithy_media_assets", "pithy_media_hashes", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
});

/** The authored chain as `media()` composes it. */
const authored = { "0001_init": media_0001_init, "0003_ownership": media_0003_ownership };

/** The columns a table holds. */
async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((row) => row.name);
}

/** Every media index, by name. */
async function indexes(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'pithy_media_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

describe("media_0001_init", () => {
  test("up creates both tables", async () => {
    await runMigrations(env.DB, provider({ "0001_init": media_0001_init }));
    expect(await tables()).toEqual(["pithy_media_assets", "pithy_media_hashes"]);
  });

  test("the record table carries its type index and the hash table both of its own", async () => {
    // Named exactly, because an index a query was planned around is part of the read's contract.
    await runMigrations(env.DB, provider({ "0001_init": media_0001_init }));
    expect(await indexes()).toEqual([
      "pithy_media_assets_type_idx",
      "pithy_media_hashes_phash_idx",
      "pithy_media_hashes_sha256_idx",
    ]);
  });

  test("down drops both tables, and up is re-runnable after it", async () => {
    const p = provider({ "0001_init": media_0001_init });
    await runMigrations(env.DB, p);
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      [composedKey("0001_init"), "Down", "Success"],
    ]);
    expect(await tables()).toEqual([]);
    await runMigrations(env.DB, p);
    expect(await tables()).toEqual(["pithy_media_assets", "pithy_media_hashes"]);
  });
});

describe("media_0003_ownership", () => {
  test("up adds the owner, organization, visibility and signing columns, and a record round-trips", async () => {
    await runMigrations(env.DB, provider(authored));
    expect(await columns("pithy_media_assets")).toEqual(
      expect.arrayContaining(["owner_id", "organization_id", "visibility", "signed_delivery"]),
    );
    expect(await columns("pithy_media_hashes")).toEqual(expect.arrayContaining(["owner_id", "organization_id"]));
    const store = d1RecordStore(mediaDatabase(env.DB), extendMediaAsset());
    await store.create(makeRecord());
    expect(await store.get("m1")).toMatchObject({ ownerId: "u-1", organizationId: "org-a", visibility: "private" });
  });

  test("indexes the reads the way they ask: owner and organization over time, and the scope leading every dedup lookup", async () => {
    await runMigrations(env.DB, provider(authored));
    expect(await indexes()).toEqual([
      "pithy_media_assets_organization_created_idx",
      "pithy_media_assets_owner_created_idx",
      "pithy_media_assets_type_idx",
      "pithy_media_hashes_organization_phash_idx",
      "pithy_media_hashes_organization_sha256_idx",
      "pithy_media_hashes_owner_phash_idx",
      "pithy_media_hashes_owner_sha256_idx",
      "pithy_media_hashes_phash_idx",
      "pithy_media_hashes_sha256_idx",
    ]);
  });

  test("an existing record becomes private and system-owned, with signing not yet enforced", async () => {
    await runMigrations(env.DB, provider({ "0001_init": media_0001_init }));
    // A row as the released schema wrote it — no owner, no organization, no visibility.
    await env.DB.prepare(
      `INSERT INTO pithy_media_assets (id, type, status, name, filename, content_type, storage_backend, storage_key,
         has_transcription, has_extracted_text, created_at, updated_at)
       VALUES ('old', 'image', 'stored', 'n', 'a.png', 'image/png', 'cf-images', 'k', 0, 0, 1, 1)`,
    ).run();
    await runMigrations(env.DB, provider(authored));
    const row = await env.DB.prepare(
      "SELECT owner_id, organization_id, visibility, signed_delivery FROM pithy_media_assets WHERE id = 'old'",
    ).first();
    expect(row).toEqual({ owner_id: null, organization_id: null, visibility: "private", signed_delivery: 0 });
  });

  test("the database refuses a visibility the code has no branch for", async () => {
    await runMigrations(env.DB, provider(authored));
    await env.DB.prepare(
      `INSERT INTO pithy_media_assets (id, type, status, name, filename, content_type, storage_backend, storage_key,
         has_transcription, has_extracted_text, created_at, updated_at)
       VALUES ('x', 'image', 'stored', 'n', 'a.png', 'image/png', 'cf-images', 'k', 0, 0, 1, 1)`,
    ).run();
    await expect(
      env.DB.prepare("UPDATE pithy_media_assets SET visibility = 'everyone' WHERE id = 'x'").run(),
    ).rejects.toThrow();
  });

  test("down removes exactly what up added, and up is re-runnable after it", async () => {
    const p = provider(authored);
    await runMigrations(env.DB, p);
    const before = { assets: await columns("pithy_media_assets"), hashes: await columns("pithy_media_hashes") };
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      [composedKey("0003_ownership"), "Down", "Success"],
    ]);
    expect(await columns("pithy_media_assets")).not.toContain("owner_id");
    expect(await columns("pithy_media_assets")).not.toContain("visibility");
    expect(await columns("pithy_media_hashes")).not.toContain("organization_id");
    expect(await indexes()).toEqual([
      "pithy_media_assets_type_idx",
      "pithy_media_hashes_phash_idx",
      "pithy_media_hashes_sha256_idx",
    ]);
    await runMigrations(env.DB, p);
    expect({ assets: await columns("pithy_media_assets"), hashes: await columns("pithy_media_hashes") }).toEqual(
      before,
    );
  });
});

describe("media 0002_extend (generated extension migration)", () => {
  const extension = z
    .object({ album: z.string().describe("Album."), rank: z.number().int().nullish().describe("Sort rank.") })
    .describe("Adopter extension fields.");

  function extended(): Record<string, Migration> {
    const extendMigration = mediaExtendMigration(extensionColumns(extension));
    if (!extendMigration) throw new Error("expected an extension migration");
    return { ...authored, "0002_extend": extendMigration };
  }

  test("up adds the adopter's columns, and an extension field round-trips", async () => {
    await runMigrations(env.DB, provider(extended()));
    const store = d1RecordStore(mediaDatabase(env.DB, extendMediaAsset(extension)), extendMediaAsset(extension));
    await store.create(makeRecord({ album: "summer" }));
    expect((await store.get("m1"))?.album).toBe("summer");
  });

  test("down removes the adopter's columns", async () => {
    const p = provider(extended());
    await runMigrations(env.DB, p);
    // The extension sorts before ownership, so ownership comes down first and the extension after it.
    await rollbackMigration(env.DB, p);
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      [composedKey("0002_extend"), "Down", "Success"],
    ]);
    expect(await columns("pithy_media_assets")).not.toContain("album");
  });
});
