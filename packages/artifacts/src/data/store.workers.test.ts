// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { artifacts_0001_init } from "../migrations/0001_init";
import type { ArtifactsRepoRecord } from "./records";
import { artifactsStore } from "./store";
import { artifactsDatabase } from "./tables";

const at = new Date("2026-10-18T12:00:00Z");

function repo(name: string, overrides: Partial<ArtifactsRepoRecord> = {}): ArtifactsRepoRecord {
  return {
    name,
    displayName: "docs",
    ownerKind: "user",
    ownerId: "alice",
    remoteAccess: true,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const store = () => artifactsStore(artifactsDatabase(env.DB));

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_grants");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_repos");
  await artifacts_0001_init.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

describe("artifactsStore", () => {
  test("a repository round-trips through its codec", async () => {
    await store().insertRepo(repo("r1", { remoteAccess: false }));
    expect(await store().getRepo("r1")).toEqual(repo("r1", { remoteAccess: false }));
    expect(await store().getRepo("missing")).toBeUndefined();
  });

  test("two owners may both hold a repository displayed as `docs`; one owner may not hold two", async () => {
    await store().insertRepo(repo("r1"));
    await store().insertRepo(repo("r2", { ownerId: "bob" }));
    await store().insertRepo(repo("r3", { ownerKind: "org", ownerId: "alice" }));
    const error = await store()
      .insertRepo(repo("r4"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("artifacts/name_taken");
  });

  test("a person sees what they own and what they are granted, and nobody else's", async () => {
    await store().insertRepo(repo("alice-docs"));
    await store().insertRepo(repo("bob-docs", { ownerId: "bob" }));
    await store().insertRepo(repo("bob-notes", { ownerId: "bob", displayName: "notes" }));
    await store().setGrant("bob-notes", "alice", "read", at);
    const seen = await store().listVisible("alice");
    expect(seen.map((entry) => [entry.repo.name, entry.grant])).toEqual([
      ["alice-docs", null],
      ["bob-notes", "read"],
    ]);
    expect((await store().listVisible("bob")).map((entry) => entry.repo.name)).toEqual(["bob-docs", "bob-notes"]);
  });

  test("a grant is upserted, read back, and removed", async () => {
    await store().insertRepo(repo("r1"));
    await store().setGrant("r1", "carol", "read", at);
    await store().setGrant("r1", "carol", "write", new Date(at.getTime() + 1000));
    expect((await store().getGrant("r1", "carol"))?.grant).toBe("write");
    expect(await store().removeGrant("r1", "carol")).toBe(true);
    expect(await store().removeGrant("r1", "carol")).toBe(false);
    expect(await store().getGrant("r1", "carol")).toBeUndefined();
  });

  test("a grant value the catalog does not know is refused on read, never asserted", async () => {
    await store().insertRepo(repo("r1"));
    await env.DB.prepare(
      "INSERT INTO pithy_artifacts_grants (repo, user_id, \"grant\", created_at, updated_at) VALUES ('r1', 'mallory', 'admin', 0, 0)",
    ).run();
    const error = await store()
      .getGrant("r1", "mallory")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("artifacts/not_found");
    // And it grants no visibility either.
    expect(await store().listVisible("mallory")).toEqual([]);
  });

  test("deleting a repository takes its grants with it", async () => {
    await store().insertRepo(repo("r1"));
    await store().setGrant("r1", "carol", "write", at);
    await store().deleteRepo("r1");
    expect(await store().getRepo("r1")).toBeUndefined();
    expect(await store().getGrant("r1", "carol")).toBeUndefined();
  });

  test("lists an owner's repositories, and answers whether a display name is taken", async () => {
    await store().insertRepo(repo("o1", { ownerKind: "org", ownerId: "acme", displayName: "site" }));
    await store().insertRepo(repo("o2", { ownerKind: "org", ownerId: "acme", displayName: "app" }));
    await store().insertRepo(repo("o3", { ownerKind: "org", ownerId: "other", displayName: "site" }));
    expect((await store().listOwned("org", "acme")).map((entry) => entry.name)).toEqual(["o2", "o1"]);
    expect(await store().displayNameTaken("org", "acme", "site")).toBe(true);
    expect(await store().displayNameTaken("user", "acme", "site")).toBe(false);
  });
});
