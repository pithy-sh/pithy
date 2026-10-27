// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { beforeEach, describe, expect, test } from "vitest";
import { media } from "../capability";
import { MediaConfig } from "../config/config";
import { MediaHash } from "../data/mediaHash";
import { MEDIA_HASHES_TABLE, mediaHashDatabase } from "../data/tables";
import { createMedia } from "../http/handlers";
import type { CreateMediaInput } from "../http/schemas";
import { caller, fakeStorage, makeDeps, resetMediaTables } from "../test-utils/harness";
import {
  MEDIA_ORGANIZATION_PURGE_SUMMARY,
  MEDIA_USER_PURGE_SUMMARY,
  mediaOrganizationPurge,
  mediaUserPurge,
} from "./contribution";

/**
 * Media's part of an organization's purge (#623), over real D1: every record the organization holds goes, with
 * its bytes and its hashes, and nothing another organization or nobody holds is touched.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const CONFIG = MediaConfig.parse({});

const image: CreateMediaInput = {
  type: "image",
  name: "A photo",
  filename: "a.png",
  contentType: "image/png",
  size: 2048,
  width: 800,
  height: 600,
};

beforeEach(() => resetMediaTables(env.DB));

/** One record, written by `userId` acting for `organizationId`. */
async function upload(userId: string, organizationId: string | null): Promise<{ id: string; storageKey: string }> {
  const deps = makeDeps(env.DB, caller(userId, organizationId));
  const { id } = await createMedia(deps, image);
  const record = await deps.store.get(id);
  return { id, storageKey: String(record?.storageKey) };
}

async function remaining(): Promise<{ id: string; organization_id: string | null }[]> {
  const { results } = await env.DB.prepare("select id, organization_id from pithy_media_assets order by id").all<{
    id: string;
    organization_id: string | null;
  }>();
  return results;
}

describe("the media organization purge", () => {
  test("media() declares it for the organization subject, with a summary", () => {
    const declared = media().purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["organization", "user"]);
    expect(declared[0]?.summary).toBe(MEDIA_ORGANIZATION_PURGE_SUMMARY);
  });

  test("deletes every record the organization holds, its bytes first, and leaves every other record alone", async () => {
    const mine = [await upload("ada", ACME), await upload("bob", ACME)];
    const theirs = await upload("ada", BETA);
    const personal = await upload("ada", null);
    await mediaHashDatabase(env.DB)
      .insertInto(MEDIA_HASHES_TABLE)
      .values(
        MediaHash.encode({
          id: 1,
          mediaId: mine[0]?.id ?? "",
          organizationId: ACME,
          ownerId: "ada",
          mediaType: "image",
          sha256: "a".repeat(64),
          phash: null,
          createdAt: new Date(1_700_000_000_000),
        }),
      )
      .execute();
    const storage = fakeStorage();

    await mediaOrganizationPurge(CONFIG, async () => storage).erase({
      subject: { type: "organization", id: ACME },
      env: { DB: env.DB },
    });

    expect(storage.calls.deleted.sort()).toEqual(mine.map((record) => record.storageKey).sort());
    expect((await remaining()).map((row) => row.id).sort()).toEqual([theirs.id, personal.id].sort());
    const hashes = await env.DB.prepare("select count(*) as n from pithy_media_hashes").first<{ n: number }>();
    expect(hashes?.n).toBe(0);
  });

  test("a delete that fails fails the step and keeps the row, so the retry still knows where the bytes are", async () => {
    const record = await upload("ada", ACME);
    const storage = fakeStorage();
    storage.deleteObject = async () => {
      throw new Error("cloudflare is down");
    };
    await expect(
      mediaOrganizationPurge(CONFIG, async () => storage).erase({
        subject: { type: "organization", id: ACME },
        env: { DB: env.DB },
      }),
    ).rejects.toThrow("cloudflare is down");
    expect((await remaining()).map((row) => row.id)).toEqual([record.id]);
  });

  test("an object already gone is nothing left to erase, and a second run finds nothing", async () => {
    await upload("ada", ACME);
    const storage = fakeStorage();
    storage.deleteObject = async () => {
      throw new Error("delete object failed", { cause: Object.assign(new Error("Not Found"), { status: 404 }) });
    };
    const run = () =>
      mediaOrganizationPurge(CONFIG, async () => storage).erase({
        subject: { type: "organization", id: ACME },
        env: { DB: env.DB },
      });
    await run();
    expect(await remaining()).toEqual([]);
    await run();
  });

  test("an organization with no media resolves no storage at all", async () => {
    let resolved = false;
    await mediaOrganizationPurge(CONFIG, async () => {
      resolved = true;
      return fakeStorage();
    }).erase({ subject: { type: "organization", id: ACME }, env: { DB: env.DB } });
    expect(resolved).toBe(false);
  });
});

describe("the media user purge (#814)", () => {
  const ada = { type: "user" as const, id: "ada" };

  test("media() declares it for the user subject, with a summary and an export", () => {
    const declared = (media().purge ?? []).find((contribution) => contribution.subject === "user");
    expect(declared?.summary).toBe(MEDIA_USER_PURGE_SUMMARY);
    expect(typeof declared?.export).toBe("function");
  });

  test("exports the records the person holds as themselves, and no credential", async () => {
    const personal = await upload("ada", null);
    await upload("ada", ACME);
    await upload("bob", null);
    const data = await mediaUserPurge(CONFIG).export?.({ subject: ada, env: { DB: env.DB } });
    expect(data?.records).toEqual([expect.objectContaining({ id: personal.id, ownerId: "ada", organizationId: null })]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("erases them, bytes first, and leaves an organization's record and anybody else's", async () => {
    const personal = [await upload("ada", null), await upload("ada", null)];
    const forAcme = await upload("ada", ACME);
    const bobs = await upload("bob", null);
    const storage = fakeStorage();
    const purge = mediaUserPurge(CONFIG, undefined, async () => storage);
    await purge.erase({ subject: ada, env: { DB: env.DB } });
    expect(storage.calls.deleted.sort()).toEqual(personal.map((record) => record.storageKey).sort());
    expect((await remaining()).map((row) => row.id).sort()).toEqual([forAcme.id, bobs.id].sort());
    expect(await purge.export?.({ subject: ada, env: { DB: env.DB } })).toEqual({ records: [] });
    await expect(purge.erase({ subject: ada, env: { DB: env.DB } })).resolves.toBeUndefined();
  });
});
