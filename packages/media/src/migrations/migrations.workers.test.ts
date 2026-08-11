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
import { d1HashStore } from "../record/hashStore";
import type { MediaRecord } from "../record/store";
import { media_0001_init } from "./0001_init";
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

/** The one authored migration, in each of the two shapes `media()` asks it for. */
const kvMode = { "0001_init": media_0001_init({ withAssets: false }) };
const d1Mode = { "0001_init": media_0001_init({ withAssets: true }) };

describe("media_0001_init in KV record mode (the dedup table only)", () => {
  test("up creates the hash table and nothing else, and a hash row round-trips", async () => {
    await runMigrations(env.DB, provider(kvMode));
    // The exact catalog, not a `toContain`: KV mode must not leave an empty record table in an
    // adopter's database, and a `toContain` would not notice if it did.
    expect(await tables()).toEqual(["pithy_media_hashes"]);
    const hashes = d1HashStore(env.DB, () => new Date(1_700_000_000_000));
    await hashes.upsert({ mediaId: "m1", mediaType: "image", sha256: "f".repeat(64), phash: "0f0f0f0f" });
    expect(await hashes.findBySha256("f".repeat(64))).toEqual([{ mediaId: "m1", mediaType: "image" }]);
    expect(await hashes.listImagePhashes()).toEqual([{ mediaId: "m1", phash: "0f0f0f0f" }]);
  });

  test("upsert is idempotent per mediaId (a re-finalize updates, not duplicates)", async () => {
    await runMigrations(env.DB, provider(kvMode));
    const hashes = d1HashStore(env.DB);
    await hashes.upsert({ mediaId: "m1", mediaType: "image", sha256: "a".repeat(64), phash: "1111" });
    await hashes.upsert({ mediaId: "m1", mediaType: "image", sha256: "b".repeat(64), phash: "2222" });
    expect(await hashes.findBySha256("a".repeat(64))).toEqual([]);
    expect(await hashes.findBySha256("b".repeat(64))).toEqual([{ mediaId: "m1", mediaType: "image" }]);
  });

  test("down drops the hash table, and up is re-runnable after it", async () => {
    const p = provider(kvMode);
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);
    expect(await tables()).toEqual([]);
    await runMigrations(env.DB, p);
    expect(await tables()).toEqual(["pithy_media_hashes"]);
  });
});

describe("media_0001_init in D1 record mode (both tables)", () => {
  test("up creates both tables and a record round-trips through the D1 store", async () => {
    await runMigrations(env.DB, provider(d1Mode));
    expect(await tables()).toEqual(["pithy_media_assets", "pithy_media_hashes"]);
    const store = d1RecordStore(mediaDatabase(env.DB), extendMediaAsset());
    await store.create(makeRecord());
    const read = await store.get("m1");
    expect(read?.name).toBe("A photo");
    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.hasTranscription).toBe(false);
  });

  test("the record table carries its type index and the hash table both of its own", async () => {
    // Named exactly, because an index a query was planned around is part of the read's contract, and
    // folding two migrations into one is precisely the change that can drop one without a test noticing.
    await runMigrations(env.DB, provider(d1Mode));
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'pithy_media_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual([
      "pithy_media_assets_type_idx",
      "pithy_media_hashes_phash_idx",
      "pithy_media_hashes_sha256_idx",
    ]);
  });

  test("down drops both tables, and up is re-runnable after it", async () => {
    const p = provider(d1Mode);
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

describe("media 0002_extend (generated extension migration)", () => {
  const extension = z
    .object({ userId: z.string().describe("Owning user id."), rank: z.number().int().nullish().describe("Sort rank.") })
    .describe("Adopter extension fields.");

  function extended(): Record<string, Migration> {
    const extendMigration = mediaExtendMigration(extensionColumns(extension));
    if (!extendMigration) throw new Error("expected an extension migration");
    return { ...d1Mode, "0002_extend": extendMigration };
  }

  test("up adds the adopter's columns, and an extension field round-trips", async () => {
    await runMigrations(env.DB, provider(extended()));
    const store = d1RecordStore(mediaDatabase(env.DB, extendMediaAsset(extension)), extendMediaAsset(extension));
    await store.create(makeRecord({ userId: "u-42" }));
    expect((await store.get("m1"))?.userId).toBe("u-42");
  });

  test("down removes the adopter's columns", async () => {
    const p = provider(extended());
    await runMigrations(env.DB, p);
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      [composedKey("0002_extend"), "Down", "Success"],
    ]);
    const { results: columns } = await env.DB.prepare("PRAGMA table_info(pithy_media_assets)").all<{ name: string }>();
    expect(columns.map((c) => c.name)).not.toContain("user_id");
  });
});
