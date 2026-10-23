// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { storage } from "../capability";
import { StorageShare } from "../data/share";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE, storageDatabase } from "../data/tables";
import { storage_0001_objects } from "../migrations/0001_objects";
import { storage_0002_ownership } from "../migrations/0002_ownership";
import { STORAGE_ORGANIZATION_PURGE_SUMMARY, storageOrganizationPurge } from "./contribution";

/**
 * Storage's part of an organization's purge (#623), over real D1 and a real Miniflare R2 bucket: every file the
 * organization holds goes, bytes and share links included, and nothing another organization or nobody holds is
 * touched.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-23T12:00:00.000Z");

let sequence = 0;

/** One stored file, its bytes in the bucket, for an owner acting for `organizationId`. */
async function stored(organizationId: string | null): Promise<{ id: string; key: string }> {
  sequence += 1;
  const id = `3f2504e0-4f89-41d3-9a0c-0305e82c${String(sequence).padStart(4, "0")}`;
  const key = `obj/${id}`;
  await env.STORAGE_BUCKET.put(key, "bytes");
  await storageDatabase(env.DB)
    .insertInto(STORAGE_OBJECTS_TABLE)
    .values(
      StorageObject.encode({
        id,
        key,
        path: `${id}.bin`,
        ownerId: "ada",
        organizationId,
        contentType: "application/octet-stream",
        size: 5,
        visibility: "private",
        checksum: null,
        status: "stored",
        uploadId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    .execute();
  return { id, key };
}

async function share(objectId: string): Promise<void> {
  await storageDatabase(env.DB)
    .insertInto(STORAGE_SHARES_TABLE)
    .values(
      StorageShare.encode({ token: `token-${objectId}`, objectId, expiresAt: null, revokedAt: null, createdAt: NOW }),
    )
    .execute();
}

const erase = () =>
  storageOrganizationPurge().erase({
    subject: { type: "organization", id: ACME },
    env: { DB: env.DB, STORAGE_BUCKET: env.STORAGE_BUCKET },
  });

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_shares");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_objects");
  const db = storageDatabase(env.DB) as unknown as Kysely<unknown>;
  await storage_0001_objects.up(db);
  await storage_0002_ownership.up(db);
});

describe("the storage organization purge", () => {
  test("storage() declares it for the organization subject, with a summary", () => {
    const declared = storage().purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["organization"]);
    expect(declared[0]?.summary).toBe(STORAGE_ORGANIZATION_PURGE_SUMMARY);
  });

  test("deletes every file the organization holds, its bytes and its shares, and leaves every other file alone", async () => {
    const mine = [await stored(ACME), await stored(ACME)];
    const theirs = await stored(BETA);
    const personal = await stored(null);
    for (const file of [...mine, theirs]) await share(file.id);

    await erase();

    for (const file of mine) expect(await env.STORAGE_BUCKET.head(file.key)).toBeNull();
    for (const file of [theirs, personal]) expect(await env.STORAGE_BUCKET.head(file.key)).not.toBeNull();
    const { results: rows } = await env.DB.prepare("select id from pithy_storage_objects order by id").all<{
      id: string;
    }>();
    expect(rows.map((row) => row.id)).toEqual([theirs.id, personal.id].sort());
    const { results: shares } = await env.DB.prepare("select object_id from pithy_storage_shares").all<{
      object_id: string;
    }>();
    expect(shares.map((row) => row.object_id)).toEqual([theirs.id]);
  });

  test("a second run finds nothing to do and succeeds", async () => {
    await stored(ACME);
    await erase();
    await erase();
    const count = await env.DB.prepare("select count(*) as n from pithy_storage_objects").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
