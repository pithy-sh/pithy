// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { artifacts_0001_init } from "../migrations/0001_init";
import { artifacts_0002_tokens } from "../migrations/0002_tokens";
import type { ArtifactsRepoRecord, ArtifactsRevocationRecord, ArtifactsTokenRecord } from "./records";
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

function token(id: string, overrides: Partial<ArtifactsTokenRecord> = {}): ArtifactsTokenRecord {
  return {
    id,
    repo: "r1",
    userId: "alice",
    scope: "write",
    source: "credential",
    createdAt: at,
    expiresAt: new Date(at.getTime() + 900_000),
    ...overrides,
  };
}

function revocation(overrides: Partial<ArtifactsRevocationRecord> = {}): ArtifactsRevocationRecord {
  return {
    connectionId: "c1",
    idempotencyKey: "k1",
    kind: "all",
    repo: "r1",
    tokenId: null,
    reason: "Laptop stolen.",
    revoked: 2,
    createdAt: at,
    ...overrides,
  };
}

beforeEach(async () => {
  for (const table of ["revocations", "tokens", "grants", "repos"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS pithy_artifacts_${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await artifacts_0001_init.up(db);
  await artifacts_0002_tokens.up(db);
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

  test("deleting a repository takes its token records with it", async () => {
    await store().insertRepo(repo("r1"));
    await store().recordTokens([token("tok_1")]);
    await store().deleteRepo("r1");
    expect(await store().tokenRecords("r1")).toEqual([]);
  });

  test("a token record round-trips, and a second record of one id is refused", async () => {
    await store().recordTokens([token("tok_1"), token("tok_2", { userId: "bob", scope: "read" })]);
    await store().recordTokens([token("tok_3", { repo: "r2" })]);
    expect(await store().tokenRecords("r1")).toEqual([
      token("tok_1"),
      token("tok_2", { userId: "bob", scope: "read" }),
    ]);
    await expect(store().recordTokens([token("tok_1")])).rejects.toThrow();
    await store().recordTokens([]);
  });

  test("a token record holds no plaintext, whatever it is handed", async () => {
    const leaky = { ...token("tok_1"), plaintext: "art_v1_secret" } as ArtifactsTokenRecord;
    await store().recordTokens([leaky]);
    const { results } = await env.DB.prepare("SELECT * FROM pithy_artifacts_tokens").all();
    expect(JSON.stringify(results)).not.toMatch(/art_v1_/);
  });

  test("prunes a repository's records that expired before the cutoff, and nobody else's", async () => {
    await store().recordTokens([
      token("old", { expiresAt: new Date(at.getTime() - 1) }),
      token("live"),
      token("other", { repo: "r2", expiresAt: new Date(at.getTime() - 1) }),
    ]);
    await store().pruneTokens("r1", at);
    expect((await store().tokenRecords("r1")).map((record) => record.id)).toEqual(["live"]);
    expect((await store().tokenRecords("r2")).map((record) => record.id)).toEqual(["other"]);
  });

  test("names the recorded tokens on a repository that have not expired, and nobody else's", async () => {
    await store().recordTokens([
      token("expired", { expiresAt: new Date(at.getTime() - 1) }),
      token("ending", { expiresAt: at }),
      token("live"),
      token("create", { source: "create", expiresAt: new Date(at.getTime() + 86_400_000) }),
      token("other", { repo: "r2" }),
    ]);
    expect(await store().unexpiredTokenIds("r1", at)).toEqual(["create", "live"]);
    expect(await store().unexpiredTokenIds("r3", at)).toEqual([]);
  });

  test("pages every repository newest first by keyset, ties broken by name", async () => {
    await store().insertRepo(repo("a", { displayName: "a", createdAt: new Date(at.getTime() - 2000) }));
    await store().insertRepo(repo("b", { displayName: "b" }));
    await store().insertRepo(repo("c", { displayName: "c" }));
    await store().insertRepo(repo("d", { displayName: "d", ownerId: "bob", createdAt: new Date(at.getTime() - 1000) }));
    const first = await store().listRepos({ limit: 2 });
    expect(first.items.map((entry) => entry.name)).toEqual(["c", "b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await store().listRepos({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((entry) => entry.name)).toEqual(["d", "a"]);
    expect(second.nextCursor).toBeNull();
    // A cursor that is not one of ours is a first page, never an error.
    expect((await store().listRepos({ limit: 2, cursor: "garbage" })).items.map((entry) => entry.name)).toEqual([
      "c",
      "b",
    ]);
  });

  test("lists a repository's grants by user, skipping a value the catalog does not know", async () => {
    await store().insertRepo(repo("r1"));
    await store().setGrant("r1", "carol", "write", at);
    await store().setGrant("r1", "bob", "read", at);
    await env.DB.prepare(
      "INSERT INTO pithy_artifacts_grants (repo, user_id, \"grant\", created_at, updated_at) VALUES ('r1', 'mallory', 'admin', 0, 0)",
    ).run();
    expect((await store().listGrants("r1")).map((grant) => [grant.userId, grant.grant])).toEqual([
      ["bob", "read"],
      ["carol", "write"],
    ]);
  });

  test("a revocation is recorded once per connection and key, and read back", async () => {
    expect(await store().getRevocation("c1", "k1")).toBeUndefined();
    expect(await store().insertRevocation(revocation())).toBe(true);
    expect(await store().insertRevocation(revocation({ revoked: 9 }))).toBe(false);
    expect(await store().getRevocation("c1", "k1")).toEqual(revocation());
    expect(await store().insertRevocation(revocation({ connectionId: "c2", kind: "token", tokenId: "tok_1" }))).toBe(
      true,
    );
    expect((await store().getRevocation("c2", "k1"))?.tokenId).toBe("tok_1");
  });
});
