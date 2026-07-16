import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MEDIA_MIGRATION_ORDER } from "../capability";
import { extendMediaAsset, extensionColumns } from "../data/extend";
import { mediaDatabase } from "../data/tables";
import { d1RecordStore } from "../record/d1Store";
import type { MediaRecord } from "../record/store";
import { media_0001_init } from "./0001_init";
import { mediaExtendMigration } from "./extend";

/** A minimal, valid stored image record for round-trip assertions. */
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

function baseProvider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "media", order: MEDIA_MIGRATION_ORDER, migrations: { "0001_init": media_0001_init } },
  ]);
  const provider = registry.app;
  if (!provider) throw new Error('expected a provider for database "app"');
  return provider;
}

/** List the non-internal user tables currently present. */
async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'pithy_migrations%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_media_assets");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_migrations");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_migrations_lock");
});

describe("media_0001_init", () => {
  test("up creates the media table and a record round-trips through the D1 store", async () => {
    const results = await runMigrations(env.DB, baseProvider());
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_media_0001_init", "Up", "Success"],
    ]);
    expect(await tables()).toContain("pithy_media_assets");

    const store = d1RecordStore(mediaDatabase(env.DB), extendMediaAsset());
    const record = makeRecord();
    await store.create(record);
    const read = await store.get("m1");
    expect(read?.name).toBe("A photo");
    // Codec round-trip: Date and boolean survive the D1 (integer) row shape.
    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.createdAt.getTime()).toBe(1_700_000_000_000);
    expect(read?.hasTranscription).toBe(false);
  });

  test("down drops the media table and its indexes", async () => {
    const provider = baseProvider();
    await runMigrations(env.DB, provider);
    const results = await rollbackMigration(env.DB, provider);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_media_0001_init", "Down", "Success"],
    ]);
    expect(await tables()).not.toContain("pithy_media_assets");
  });
});

describe("media 0002_extend (generated extension migration)", () => {
  const extension = z
    .object({ userId: z.string().describe("Owning user id."), rank: z.number().int().nullish().describe("Sort rank.") })
    .describe("Adopter extension fields.");

  function extendedProvider(): MigrationProvider {
    const extendMigration = mediaExtendMigration(extensionColumns(extension));
    if (!extendMigration) throw new Error("expected an extension migration");
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "media",
        order: MEDIA_MIGRATION_ORDER,
        migrations: { "0001_init": media_0001_init, "0002_extend": extendMigration },
      },
    ]);
    const provider = registry.app;
    if (!provider) throw new Error('expected a provider for database "app"');
    return provider;
  }

  test("up adds the adopter's columns, and an extension field round-trips", async () => {
    await runMigrations(env.DB, extendedProvider());
    const store = d1RecordStore(mediaDatabase(env.DB, extendMediaAsset(extension)), extendMediaAsset(extension));
    await store.create(makeRecord({ userId: "u-42" } as Partial<MediaRecord>));
    const read = await store.get("m1");
    expect(read?.userId).toBe("u-42");
  });

  test("down removes the adopter's columns", async () => {
    const provider = extendedProvider();
    await runMigrations(env.DB, provider);
    // Roll back only the extension migration (the latest); the base table stays.
    const results = await rollbackMigration(env.DB, provider);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_media_0002_extend", "Down", "Success"],
    ]);
    const { results: columns } = await env.DB.prepare("PRAGMA table_info(pithy_media_assets)").all<{ name: string }>();
    expect(columns.map((c) => c.name)).not.toContain("user_id");
  });
});
