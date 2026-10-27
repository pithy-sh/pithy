// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { ArtifactsNamespaceBinding } from "../binding/artifacts";
import { artifacts } from "../capability";
import type { ArtifactsRepoRecord } from "../data/records";
import { artifactsStore } from "../data/store";
import { artifactsDatabase } from "../data/tables";
import { artifacts_0001_init } from "../migrations/0001_init";
import { ARTIFACTS_PURGE_SUMMARY, artifactsUserPurge } from "./contribution";

/**
 * Artifacts' part of a person's purge and export (#814), over real D1 and a namespace that answers the way
 * Cloudflare's documents: the person's own repositories go with their contents, the grants they hold go, and an
 * organization's repository and anybody else's are untouched.
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

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_grants");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_repos");
  await artifacts_0001_init.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  const store = artifactsStore(artifactsDatabase(env.DB));
  await store.insertRepo(repo("ada-notes", "user", "ada"));
  await store.insertRepo(repo("acme-site", "org", "ada"));
  await store.insertRepo(repo("bob-docs", "user", "bob"));
  await store.setGrant("ada-notes", "bob", "read", AT);
  await store.setGrant("bob-docs", "ada", "write", AT);
  live = new Set(["ada-notes", "acme-site", "bob-docs"]);
});

describe("the artifacts user purge", () => {
  test("artifacts() declares it for the user subject, with a summary and an export", () => {
    const declared = artifacts().purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(ARTIFACTS_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the repositories the person owns and the grants they hold, and no credential", async () => {
    const data = await exportOf("ada");
    expect((data.repositories as { name: string }[]).map((entry) => entry.name)).toEqual(["ada-notes"]);
    expect(data.grants).toEqual([expect.objectContaining({ repo: "bob-docs", userId: "ada", grant: "write" })]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("erases their repositories with their contents and every grant on them, and the grants they hold", async () => {
    await purge.erase(context("ada"));
    expect([...live].sort()).toEqual(["acme-site", "bob-docs"]);
    expect(await exportOf("ada")).toEqual({ repositories: [], grants: [] });
    const store = artifactsStore(artifactsDatabase(env.DB));
    expect(await store.getRepo("acme-site")).toBeDefined();
    expect(await store.getRepo("bob-docs")).toBeDefined();
    const left = await env.DB.prepare("SELECT repo, user_id FROM pithy_artifacts_grants").all();
    expect(left.results).toEqual([]);
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });
});
