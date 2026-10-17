// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AccessCaller } from "@pithy-sh/core/src/access/access";
import { beforeEach, describe, expect, test } from "vitest";
import { d1HashStore } from "../record/hashStore";
import { caller, makeDeps, resetMediaTables } from "../test-utils/harness";
import { createMedia, finalizeMedia, searchDuplicates } from "./handlers";
import type { CreateMediaInput } from "./schemas";

/**
 * *Do you have this file* is not a question one tenant may ask about another. Duplicate detection runs
 * within the organization in force, or the owner's own records when none is — on the exact path and on
 * the near-duplicate path alike — and is account-wide only where the adopter configured it.
 */

const SHA = "c".repeat(64);
const PHASH = "00ff00ff00ff00ff";
const NEAR = "00ff00ff00ff00fe";

const VICTIM = caller("victim", "org-victim");
const VICTIM_COLLEAGUE = caller("colleague", "org-victim");
const PROBER = caller("prober", "org-prober");
const LONE_PROBER = caller("loner");

const image: CreateMediaInput = {
  type: "image",
  name: "secret plan",
  filename: "plan.png",
  contentType: "image/png",
  size: 10,
  sha256: SHA,
  phash: PHASH,
};

beforeEach(() => resetMediaTables(env.DB));

/** A stored image the given caller uploaded. */
async function upload(who: AccessCaller, visibility: "private" | "organization" | "public" = "private") {
  const deps = makeDeps(env.DB, who);
  const { id } = await createMedia(deps, { ...image, visibility });
  await finalizeMedia(deps, id, {});
  return id;
}

/** Every match the caller's search returns, on both paths. */
async function search(who: AccessCaller, phash = NEAR, config = {}) {
  const deps = makeDeps(env.DB, who, { config });
  return (await searchDuplicates(deps, { type: "image", sha256: SHA, phash })).matches.map((match) => match.id);
}

describe("one tenant cannot discover another tenant's file", () => {
  test("on the exact path: another organization's identical bytes are not found", async () => {
    await upload(VICTIM);
    expect(await search(PROBER, "ffffffffffffffff")).toEqual([]);
  });

  test("on the near-duplicate path: another organization's similar image is not compared against", async () => {
    await upload(VICTIM);
    const deps = makeDeps(env.DB, PROBER);
    const { matches } = await searchDuplicates(deps, { type: "image", sha256: "d".repeat(64), phash: NEAR });
    expect(matches).toEqual([]);
  });

  test("an owner acting for no organization does not reach records written for one — even their own", async () => {
    await upload(caller("victim", "org-victim"));
    expect(await search(caller("victim"))).toEqual([]);
    await upload(caller("victim"));
    expect(await search(LONE_PROBER)).toEqual([]);
  });

  test("the hash store itself answers only within the scope asked — the lookup, not just the handler", async () => {
    const id = await upload(VICTIM);
    const hashes = d1HashStore(env.DB);
    expect(await hashes.findBySha256(SHA, { organizationId: "org-prober" })).toEqual([]);
    expect(await hashes.listImagePhashes({ organizationId: "org-prober" })).toEqual([]);
    expect(await hashes.findBySha256(SHA, { organizationId: "org-victim" })).toEqual([
      { mediaId: id, mediaType: "image" },
    ]);
  });
});

describe("within a tenant", () => {
  test("the uploader finds their own exact and near duplicates", async () => {
    const id = await upload(VICTIM);
    expect(await search(VICTIM)).toEqual([id]);
    const deps = makeDeps(env.DB, VICTIM);
    const near = await searchDuplicates(deps, { type: "image", sha256: "d".repeat(64), phash: NEAR });
    expect(near.matches.map((match) => match.kind)).toEqual(["similar"]);
  });

  test("a colleague finds an organization record, and never a colleague's private one", async () => {
    const shared = await upload(VICTIM, "organization");
    await upload(VICTIM, "private");
    expect(await search(VICTIM_COLLEAGUE)).toEqual([shared]);
  });

  test("a colleague's private matches never crowd the caller's own out of the limit", async () => {
    for (let i = 0; i < 3; i++) await upload(VICTIM, "private");
    const own = await upload(VICTIM_COLLEAGUE, "private");
    const deps = makeDeps(env.DB, VICTIM_COLLEAGUE);
    const { matches } = await searchDuplicates(deps, { type: "image", sha256: SHA, phash: NEAR, limit: 2 });
    expect(matches.map((match) => match.id)).toEqual([own]);
  });
});

describe("account-wide detection", () => {
  test("is reachable only by asking for it explicitly in config", async () => {
    const id = await upload(VICTIM);
    expect(await search(PROBER)).toEqual([]);
    expect(await search(PROBER, NEAR, { dedup: { scope: "account" } })).toEqual([id]);
  });
});

describe("the permission hook cannot widen duplicate detection", () => {
  test("an allow-everything hook still finds nothing across tenants", async () => {
    await upload(VICTIM);
    const deps = makeDeps(env.DB, PROBER, { permission: () => "allow" });
    expect((await searchDuplicates(deps, { type: "image", sha256: SHA, phash: NEAR })).matches).toEqual([]);
  });
});
