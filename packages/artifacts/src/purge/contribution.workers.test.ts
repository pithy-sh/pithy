// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { ArtifactsNamespaceBinding } from "../binding/artifacts";
import { artifacts } from "../capability";
import { type ArtifactsRepoRecord, TOKEN_RECORDS_BEGAN_ID } from "../data/records";
import { artifactsStore } from "../data/store";
import { artifactsDatabase } from "../data/tables";
import { artifacts_0001_init } from "../migrations/0001_init";
import { artifacts_0002_tokens } from "../migrations/0002_tokens";
import { ARTIFACTS_PURGE_SUMMARY, artifactsUserPurge } from "./contribution";

/**
 * Artifacts' part of a person's purge and export (#814), over real D1 and a namespace that answers the way
 * Cloudflare's documents: the person's own repositories go with their contents, the grants they hold go, the record of
 * every token minted for them goes (#832), and an organization's repository and anybody else's are untouched.
 */

const AT = new Date("2026-10-26T12:00:00.000Z");
let live: Set<string>;
const namespace = (): ArtifactsNamespaceBinding => ({
  create: async () => {
    throw new Error("not used");
  },
  get: async () => {
    throw new Error("not used");
  },
  delete: async (name) => live.delete(name),
});

const purge = artifactsUserPurge();
const context = (id: string) => ({
  subject: { type: "user" as const, id },
  env: { DB: env.DB, ARTIFACTS: namespace() },
});

async function exportOf(id: string): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(context(id));
}

function repo(name: string, ownerKind: "user" | "org", ownerId: string): ArtifactsRepoRecord {
  return { name, displayName: name, ownerKind, ownerId, remoteAccess: true, createdAt: AT, updatedAt: AT };
}

function token(id: string, repo: string, userId: string) {
  return { id, repo, userId, scope: "read" as const, source: "credential" as const, createdAt: AT, expiresAt: AT };
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_revocations");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_tokens");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_grants");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_repos");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await artifacts_0001_init.up(db);
  await artifacts_0002_tokens.up(db);
  const store = artifactsStore(artifactsDatabase(env.DB));
  await store.insertRepo(repo("ada-notes", "user", "ada"));
  await store.insertRepo(repo("acme-site", "org", "ada"));
  await store.insertRepo(repo("bob-docs", "user", "bob"));
  await store.setGrant("ada-notes", "bob", "read", AT);
  await store.setGrant("bob-docs", "ada", "write", AT);
  await store.recordTokens([
    token("t-ada-on-bob", "bob-docs", "ada"),
    token("t-bob-on-ada", "ada-notes", "bob"),
    token("t-bob-on-bob", "bob-docs", "bob"),
  ]);
  live = new Set(["ada-notes", "acme-site", "bob-docs"]);
});

describe("the artifacts user purge", () => {
  test("artifacts() declares it for the user subject, with a summary and an export", () => {
    const declared = artifacts().purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(ARTIFACTS_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the repositories the person owns, the grants they hold and the tokens minted for them, and no credential", async () => {
    const data = await exportOf("ada");
    expect((data.repositories as { name: string }[]).map((entry) => entry.name)).toEqual(["ada-notes"]);
    expect(data.grants).toEqual([expect.objectContaining({ repo: "bob-docs", userId: "ada", grant: "write" })]);
    expect(data.mints).toEqual([expect.objectContaining({ id: "t-ada-on-bob", repo: "bob-docs", userId: "ada" })]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("erases their repositories with their contents and every grant on them, and the grants they hold", async () => {
    await purge.erase(context("ada"));
    expect([...live].sort()).toEqual(["acme-site", "bob-docs"]);
    expect(await exportOf("ada")).toEqual({ repositories: [], grants: [], mints: [] });
    const store = artifactsStore(artifactsDatabase(env.DB));
    expect(await store.getRepo("acme-site")).toBeDefined();
    expect(await store.getRepo("bob-docs")).toBeDefined();
    const left = await env.DB.prepare("SELECT repo, user_id FROM pithy_artifacts_grants").all();
    expect(left.results).toEqual([]);
  });

  test("anonymizes the record of every token minted for them, so each still reads as the kit's, and leaves the rest", async () => {
    await purge.erase(context("ada"));
    const left = await env.DB.prepare("SELECT id, repo, user_id FROM pithy_artifacts_tokens ORDER BY id").all<{
      id: string;
      repo: string;
      user_id: string;
    }>();
    // Bob's token on Ada's repository went with the repository; Bob's on his own and the marker are untouched.
    expect(left.results.map((row) => row.id)).toEqual(["pithy:records-began", "t-ada-on-bob", "t-bob-on-bob"]);
    const ada = left.results.find((row) => row.id === "t-ada-on-bob");
    expect(ada?.repo).toBe("bob-docs");
    expect(ada?.user_id).toMatch(/^erased-[0-9a-f]{32}$/);
    expect(left.results.find((row) => row.id === "t-bob-on-bob")?.user_id).toBe("bob");
    expect(left.results.find((row) => row.id === TOKEN_RECORDS_BEGAN_ID)?.user_id).toBe("");
  });

  test("gives each anonymized record its own stand-in, so two of the person's tokens cannot be joined", async () => {
    await artifactsStore(artifactsDatabase(env.DB)).recordTokens([token("t-ada-on-bob-2", "bob-docs", "ada")]);
    await purge.erase(context("ada"));
    const rows = await env.DB.prepare("SELECT user_id FROM pithy_artifacts_tokens WHERE id LIKE 't-ada-%'").all<{
      user_id: string;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(new Set(rows.results.map((row) => row.user_id)).size).toBe(2);
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });
});
