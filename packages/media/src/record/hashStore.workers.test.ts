// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { MediaDedup } from "../config/config";
import { caller, resetMediaTables } from "../test-utils/harness";
import { d1HashStore, dedupScope, type HashEntry } from "./hashStore";

/** The dedup hash store against a real D1: who a lookup reaches, and what a write leaves behind. */

const TENANT = MediaDedup.parse({});
const ACCOUNT = MediaDedup.parse({ scope: "account" });

function entry(overrides: Partial<HashEntry> = {}): HashEntry {
  return {
    mediaId: "m1",
    mediaType: "image",
    sha256: "a".repeat(64),
    phash: "ff00",
    ownerId: "owner",
    organizationId: "org-a",
    ...overrides,
  };
}

async function rowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM pithy_media_hashes").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(() => resetMediaTables(env.DB));

describe("dedupScope", () => {
  test("the organization in force, then the owner, and the account only where configured", () => {
    expect(dedupScope(caller("owner", "org-a"), TENANT)).toEqual({ organizationId: "org-a" });
    expect(dedupScope(caller("owner"), TENANT)).toEqual({ ownerId: "owner" });
    expect(dedupScope(caller("owner", "org-a"), ACCOUNT)).toEqual({ account: true });
  });

  test("a caller with no identity has no tenant, so asking is refused — never answered from the account", () => {
    expect(() => dedupScope(caller(null), TENANT)).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "core/internal",
          detail: "dedupScope called for a caller with no user and no organization",
        }),
      }),
    );
  });
});

describe("d1HashStore", () => {
  test("two records keep two rows — D1 assigns each its own id", async () => {
    const store = d1HashStore(env.DB);
    await store.upsert(entry({ mediaId: "m1" }));
    await store.upsert(entry({ mediaId: "m2" }));
    expect(await rowCount()).toBe(2);
    const found = await store.findBySha256("a".repeat(64), { organizationId: "org-a" });
    expect(found.map((m) => m.mediaId).sort()).toEqual(["m1", "m2"]);
  });

  test("a re-upsert replaces the row and rewrites its tenant, so the row always carries its record's", async () => {
    const store = d1HashStore(env.DB);
    await store.upsert(entry());
    await store.upsert(entry({ sha256: "b".repeat(64), ownerId: "other", organizationId: null }));
    expect(await rowCount()).toBe(1);

    // The old organization no longer reaches it, by either hash.
    expect(await store.findBySha256("b".repeat(64), { organizationId: "org-a" })).toEqual([]);
    expect(await store.listImagePhashes({ organizationId: "org-a" })).toEqual([]);
    // Its new owner does, with no organization in force — and the old hash is gone.
    expect(await store.findBySha256("b".repeat(64), { ownerId: "other" })).toEqual([
      { mediaId: "m1", mediaType: "image" },
    ]);
    expect(await store.findBySha256("a".repeat(64), { account: true })).toEqual([]);
  });

  test("an owner's scope is their records written with no organization, never their organization's", async () => {
    const store = d1HashStore(env.DB);
    await store.upsert(entry({ mediaId: "in-org" }));
    await store.upsert(entry({ mediaId: "personal", organizationId: null }));
    expect((await store.findBySha256("a".repeat(64), { ownerId: "owner" })).map((m) => m.mediaId)).toEqual([
      "personal",
    ]);
    expect((await store.listImagePhashes({ account: true })).map((m) => m.mediaId).sort()).toEqual([
      "in-org",
      "personal",
    ]);
  });
});
