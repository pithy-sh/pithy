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
import { media_0001_hashes } from "./0001_hashes";
import { media_0002_assets } from "./0002_assets";
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
 * `0350_media_0002_assets`. Derived from {@link MEDIA_MIGRATION_ORDER} rather than written out, so
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

describe("media_0001_hashes (dedup table — always)", () => {
  test("up creates the hash table and a hash row round-trips", async () => {
    await runMigrations(env.DB, provider({ "0001_hashes": media_0001_hashes }));
    expect(await tables()).toContain("pithy_media_hashes");
    const hashes = d1HashStore(env.DB, () => new Date(1_700_000_000_000));
    await hashes.upsert({ mediaId: "m1", mediaType: "image", sha256: "f".repeat(64), phash: "0f0f0f0f" });
    expect(await hashes.findBySha256("f".repeat(64))).toEqual([{ mediaId: "m1", mediaType: "image" }]);
    expect(await hashes.listImagePhashes()).toEqual([{ mediaId: "m1", phash: "0f0f0f0f" }]);
  });

  test("upsert is idempotent per mediaId (a re-finalize updates, not duplicates)", async () => {
    await runMigrations(env.DB, provider({ "0001_hashes": media_0001_hashes }));
    const hashes = d1HashStore(env.DB);
    await hashes.upsert({ mediaId: "m1", mediaType: "image", sha256: "a".repeat(64), phash: "1111" });
    await hashes.upsert({ mediaId: "m1", mediaType: "image", sha256: "b".repeat(64), phash: "2222" });
    expect(await hashes.findBySha256("a".repeat(64))).toEqual([]);
    expect(await hashes.findBySha256("b".repeat(64))).toEqual([{ mediaId: "m1", mediaType: "image" }]);
  });

  test("down drops the hash table", async () => {
    const p = provider({ "0001_hashes": media_0001_hashes });
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);
    expect(await tables()).not.toContain("pithy_media_hashes");
  });
});

describe("media_0002_assets (record table — D1 mode)", () => {
  const both = { "0001_hashes": media_0001_hashes, "0002_assets": media_0002_assets };

  test("up creates the record table and a record round-trips through the D1 store", async () => {
    await runMigrations(env.DB, provider(both));
    expect(await tables()).toEqual(["pithy_media_assets", "pithy_media_hashes"]);
    const store = d1RecordStore(mediaDatabase(env.DB), extendMediaAsset());
    await store.create(makeRecord());
    const read = await store.get("m1");
    expect(read?.name).toBe("A photo");
    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.hasTranscription).toBe(false);
  });

  test("down drops the record table (rolling back the latest migration)", async () => {
    const p = provider(both);
    await runMigrations(env.DB, p);
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      [composedKey("0002_assets"), "Down", "Success"],
    ]);
    expect(await tables()).toEqual(["pithy_media_hashes"]);
  });
});

describe("media 0003_extend (generated extension migration)", () => {
  const extension = z
    .object({ userId: z.string().describe("Owning user id."), rank: z.number().int().nullish().describe("Sort rank.") })
    .describe("Adopter extension fields.");

  function extended(): Record<string, Migration> {
    const extendMigration = mediaExtendMigration(extensionColumns(extension));
    if (!extendMigration) throw new Error("expected an extension migration");
    return { "0001_hashes": media_0001_hashes, "0002_assets": media_0002_assets, "0003_extend": extendMigration };
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
      [composedKey("0003_extend"), "Down", "Success"],
    ]);
    const { results: columns } = await env.DB.prepare("PRAGMA table_info(pithy_media_assets)").all<{ name: string }>();
    expect(columns.map((c) => c.name)).not.toContain("user_id");
  });
});
