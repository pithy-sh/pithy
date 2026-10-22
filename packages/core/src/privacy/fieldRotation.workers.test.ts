// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import type { EncryptionConfig } from "../crypto/envelope";
import { sqliteJson } from "../data/codecs";
import { createDatabase } from "../data/db";
import { phi, pii } from "./classes";
import { blindIndex, encrypted, encryptedTable } from "./encrypted";
import { deriveEncryptedColumns, type EncryptedColumn } from "./encryptedColumns";
import { countStale, readRetirement, resealBatch } from "./fieldRotation";
import { sealed } from "./sealed";

/**
 * **The rotator's SQL against a real D1** (#390): the stale count found by `json_extract`, a batch that re-seals and
 * re-indexes only the version leaving the window, the compare-and-swap that leaves a row the application re-sealed in
 * between, and the app Worker's own retirement verdict.
 */

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const k1 = keyB64();
const k2 = keyB64();
const k3 = keyB64();
const v1: EncryptionConfig = { currentVersion: "1", versions: { "1": k1 }, lastRotatedAt: "2026-08-01T00:00:00.000Z" };
const v2: EncryptionConfig = {
  currentVersion: "2",
  versions: { "1": k1, "2": k2 },
  lastRotatedAt: "2026-09-01T00:00:00.000Z",
};
const v3: EncryptionConfig = {
  currentVersion: "3",
  versions: { "1": k1, "2": k2, "3": k3 },
  lastRotatedAt: "2026-10-01T00:00:00.000Z",
};

const Patient = encryptedTable(
  z
    .object({
      id: z.string().describe("The patient's id, assigned by the app."),
      diagnosis: encrypted(phi(z.string().describe("The condition."))),
      email: encrypted(pii(z.string().describe("Where we write.")), { index: "email" }),
      emailIndex: blindIndex("email"),
      profile: sqliteJson(
        z.object({
          phone: encrypted(pii(z.string().describe("Phone."))).nullable(),
          city: z.string().describe("City."),
        }),
      ).describe("Profile."),
    })
    .describe("A patient."),
  { name: "patient", key: "id" },
);

const tables = { patientRecords: Patient };
const db = createDatabase(env.DB, tables);

function columns(): EncryptedColumn[] {
  const app = defineCapability({ name: "app", requiredBindings: [], databases: { app: { binding: "DB", tables } } });
  return deriveEncryptedColumns([app]).columns;
}

async function insert(config: EncryptionConfig, id: string, email = `${id}@example.com`): Promise<void> {
  const record = await sealed(Patient, { keys: config }).seal({
    id,
    diagnosis: `condition of ${id}`,
    email,
    profile: { phone: `+1 555 ${id}`, city: "Leeds" },
  } as never);
  await db.insertInto("patientRecords").values(record).execute();
}

async function readAll(config: EncryptionConfig) {
  const rows = await db.selectFrom("patientRecords").selectAll().orderBy("id").execute();
  return Promise.all(rows.map((row) => sealed(Patient, { keys: config }).open(row)));
}

beforeEach(async () => {
  await sql`DROP TABLE IF EXISTS patient_records`.execute(db);
  await sql`DROP TABLE IF EXISTS patients_renamed`.execute(db);
  await sql`CREATE TABLE patient_records (id TEXT PRIMARY KEY, diagnosis TEXT NOT NULL, email TEXT NOT NULL, email_index TEXT NOT NULL, profile TEXT NOT NULL)`.execute(
    db,
  );
});

describe("the derived columns", () => {
  test("name the declared name, the field path, the SQL table and column, the key, the binding and the index", () => {
    expect(columns()).toEqual([
      {
        name: "patient",
        path: "diagnosis",
        table: "patient_records",
        column: "diagnosis",
        jsonPath: null,
        primaryKey: "id",
        binding: "DB",
        index: null,
      },
      {
        name: "patient",
        path: "email",
        table: "patient_records",
        column: "email",
        jsonPath: null,
        primaryKey: "id",
        binding: "DB",
        index: { column: "email_index", normalizer: "email" },
      },
      {
        name: "patient",
        path: "profile.phone",
        table: "patient_records",
        column: "profile",
        jsonPath: "$.phone",
        primaryKey: "id",
        binding: "DB",
        index: null,
      },
    ]);
  });
});

describe("renaming", () => {
  test("renaming the SQL table leaves existing rows openable, because the AAD binds the declared name", async () => {
    await insert(v1, "p1");
    await sql`ALTER TABLE patient_records RENAME TO patients_renamed`.execute(db);
    const renamed = createDatabase(env.DB, { patientsRenamed: Patient });
    const [row] = await renamed.selectFrom("patientsRenamed").selectAll().execute();
    expect((await sealed(Patient, { keys: v1 }).open(row as never)).diagnosis).toBe("condition of p1");
  });
});

describe("the stale count", () => {
  test("counts every envelope and index under a version, found by json_extract, a nested one included", async () => {
    await insert(v1, "p1");
    await insert(v1, "p2");
    await insert(v2, "p3");
    const [diagnosis, email, phone] = columns() as [EncryptedColumn, EncryptedColumn, EncryptedColumn];
    expect(await countStale(env.DB, diagnosis, [1])).toBe(2);
    expect(await countStale(env.DB, email, [1])).toBe(2);
    expect(await countStale(env.DB, phone, [1])).toBe(2);
    expect(await countStale(env.DB, phone, [2])).toBe(1);
    expect(await countStale(env.DB, phone, [])).toBe(0);
  });
});

describe("the re-seal", () => {
  test("re-seals and re-indexes only the rows under the version leaving, in batches", async () => {
    for (const id of ["p1", "p2", "p3"]) await insert(v1, id);
    await insert(v2, "p4");
    const before = await db
      .selectFrom("patientRecords")
      .select(["id", "diagnosis"])
      .where("id", "=", "p4")
      .executeTakeFirst();
    for (const column of columns()) {
      const first = await resealBatch(env.DB, column, v3, 1, 2);
      const second = await resealBatch(env.DB, column, v3, 1, 2);
      expect(first.resealed + second.resealed).toBe(3);
      expect(await countStale(env.DB, column, [1])).toBe(0);
    }
    // The row on version 2 was never touched: only the version leaving the window is re-sealed.
    const after = await db
      .selectFrom("patientRecords")
      .select(["id", "diagnosis"])
      .where("id", "=", "p4")
      .executeTakeFirst();
    expect(after).toEqual(before);
    // Every row still opens, under the key set with version 1 retired, and the old index no longer matches.
    const withoutOne: EncryptionConfig = { ...v3, versions: { "2": k2, "3": k3 } };
    expect((await readAll(withoutOne)).map((one) => one.diagnosis)).toEqual([
      "condition of p1",
      "condition of p2",
      "condition of p3",
      "condition of p4",
    ]);
    const hashes = await sealed(Patient, { keys: withoutOne }).match("email", "P1@example.com");
    const found = await db.selectFrom("patientRecords").select("id").where("emailIndex", "in", hashes).execute();
    expect(found.map((row) => row.id)).toEqual(["p1"]);
  });

  test("is a compare-and-swap: a row the application re-sealed in between is left alone", async () => {
    await insert(v1, "p1");
    const [diagnosis] = columns() as [EncryptedColumn];
    // The batch read the row under version 1; before it writes, the application re-seals it under version 3.
    const raced = {
      ...env.DB,
      prepare(query: string) {
        const statement = env.DB.prepare(query);
        if (!query.startsWith("UPDATE")) return statement;
        return {
          bind: (...values: unknown[]) => ({
            run: async () => {
              await db.deleteFrom("patientRecords").execute();
              await insert(v3, "p1");
              return statement.bind(...values).run();
            },
          }),
        };
      },
    } as unknown as D1Database;
    const appWrote = async () => db.selectFrom("patientRecords").select("diagnosis").executeTakeFirstOrThrow();
    const result = await resealBatch(raced, diagnosis, v3, 1, 10);
    expect(result).toEqual({ resealed: 0, skipped: 1, failed: 0 });
    // What the application wrote stands.
    expect(JSON.parse((await appWrote()).diagnosis as string).keyVersion).toBe(3);
  });

  test("a row that will not open is counted, left, and never described", async () => {
    await insert(v1, "p1");
    const [diagnosis] = columns() as [EncryptedColumn];
    const wrongKey: EncryptionConfig = { ...v3, versions: { "1": k3, "3": k3 } };
    expect(await resealBatch(env.DB, diagnosis, wrongKey, 1, 10)).toEqual({ resealed: 0, skipped: 0, failed: 1 });
    expect(await countStale(env.DB, diagnosis, [1])).toBe(1);
  });
});

describe("readRetirement", () => {
  const app = defineCapability({ name: "app", requiredBindings: [], databases: { app: { binding: "DB", tables } } });

  test("two live versions is the normal state: nothing is due, so nothing is blocked", async () => {
    await insert(v1, "p1");
    expect(await readRetirement({ DB: env.DB, PITHY_FIELD_KEYS: JSON.stringify(v2) }, [app])).toEqual({
      blocked: false,
      reasons: [],
      liveVersions: 2,
    });
  });

  test("a third live version with rows still under it is blocked as stale", async () => {
    await insert(v1, "p1");
    expect(await readRetirement({ DB: env.DB, PITHY_FIELD_KEYS: JSON.stringify(v3) }, [app])).toEqual({
      blocked: true,
      reasons: ["stale"],
      liveVersions: 3,
    });
  });

  test("a binding the Worker lacks is incomplete coverage, never a clean guard", async () => {
    expect(await readRetirement({ PITHY_FIELD_KEYS: JSON.stringify(v3) }, [app])).toEqual({
      blocked: true,
      reasons: ["incomplete-coverage"],
      liveVersions: 3,
    });
  });

  test("a Worker with no encrypted field and no key says nothing is held", async () => {
    expect(await readRetirement({}, [defineCapability({ name: "bare", requiredBindings: [] })])).toEqual({
      blocked: false,
      reasons: [],
      liveVersions: 0,
    });
  });
});
