// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { TOKEN_RECORDS_BEGAN_ID } from "../data/records";
import { artifactsStore } from "../data/store";
import { artifactsDatabase } from "../data/tables";
import { artifacts_0001_init } from "./0001_init";
import { artifacts_0002_tokens } from "./0002_tokens";

function db(): Kysely<unknown> {
  return createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
}

/** Everything 0001 creates, as it appears in SQLite's catalog. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_artifacts_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_revocations");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_tokens");
  await env.DB.exec("DROP INDEX IF EXISTS pithy_artifacts_repos_created_idx");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_grants");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_repos");
});

describe("artifacts_0001_init", () => {
  test("up creates both tables and their indexes", async () => {
    await artifacts_0001_init.up(db());
    expect(await catalog()).toEqual([
      "pithy_artifacts_grants",
      "pithy_artifacts_grants_user_idx",
      "pithy_artifacts_repos",
      "pithy_artifacts_repos_owner_display_idx",
    ]);
  });

  test("two owners may both hold `docs`, and one owner may not hold two", async () => {
    await artifacts_0001_init.up(db());
    const insert = (name: string, ownerId: string) =>
      env.DB.prepare(
        "INSERT INTO pithy_artifacts_repos (name, display_name, owner_kind, owner_id, remote_access, created_at, updated_at) VALUES (?, 'docs', 'user', ?, 1, 0, 0)",
      )
        .bind(name, ownerId)
        .run();
    await insert("r1", "alice");
    await insert("r2", "bob");
    await expect(insert("r3", "alice")).rejects.toThrow(/UNIQUE/);
  });

  test("a person holds one grant per repository", async () => {
    await artifacts_0001_init.up(db());
    const grant = (value: string) =>
      env.DB.prepare(
        "INSERT INTO pithy_artifacts_grants (repo, user_id, \"grant\", created_at, updated_at) VALUES ('r1', 'alice', ?, 0, 0)",
      )
        .bind(value)
        .run();
    await grant("read");
    await expect(grant("write")).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  test("down is the exact inverse, and re-runnable", async () => {
    await artifacts_0001_init.up(db());
    await artifacts_0001_init.down?.(db());
    expect(await catalog()).toEqual([]);
    await artifacts_0001_init.up(db());
    expect(await catalog()).toContain("pithy_artifacts_repos");
  });
});

describe("artifacts_0002_tokens", () => {
  test("up adds the token record, the revocation record, and the repository paging index", async () => {
    await artifacts_0001_init.up(db());
    await artifacts_0002_tokens.up(db());
    expect(await catalog()).toEqual([
      "pithy_artifacts_grants",
      "pithy_artifacts_grants_user_idx",
      "pithy_artifacts_repos",
      "pithy_artifacts_repos_created_idx",
      "pithy_artifacts_repos_owner_display_idx",
      "pithy_artifacts_revocations",
      "pithy_artifacts_tokens",
      "pithy_artifacts_tokens_repo_expires_idx",
    ]);
  });

  test("a token is recorded once, and holds no column for its plaintext", async () => {
    await artifacts_0001_init.up(db());
    await artifacts_0002_tokens.up(db());
    const insert = () =>
      env.DB.prepare(
        "INSERT INTO pithy_artifacts_tokens (id, repo, user_id, scope, source, created_at, expires_at) VALUES ('tok_1', 'r1', 'alice', 'write', 'credential', 0, 0)",
      ).run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY/);
    const { results } = await env.DB.prepare("PRAGMA table_info(pithy_artifacts_tokens)").all<{ name: string }>();
    expect(results.map((column) => column.name)).toEqual([
      "id",
      "repo",
      "user_id",
      "scope",
      "source",
      "created_at",
      "expires_at",
    ]);
  });

  test("up marks when recording began, on the database's clock, where no repository's tokens reach it", async () => {
    await artifacts_0001_init.up(db());
    const before = Math.floor(Date.now() / 1000) * 1000;
    await artifacts_0002_tokens.up(db());
    const after = Date.now();
    const store = artifactsStore(artifactsDatabase(env.DB));
    const began = await store.tokenRecordsBegan();
    expect(began).toBeInstanceOf(Date);
    expect(began?.getTime()).toBeGreaterThanOrEqual(before);
    expect(began?.getTime()).toBeLessThanOrEqual(after);
    expect(await store.tokenRecords("")).toHaveLength(1);
    const { results } = await env.DB.prepare("SELECT id, repo FROM pithy_artifacts_tokens").all();
    expect(results).toEqual([{ id: TOKEN_RECORDS_BEGAN_ID, repo: "" }]);
  });

  test("without the mark, when recording began is unknown", async () => {
    await artifacts_0001_init.up(db());
    await artifacts_0002_tokens.up(db());
    await env.DB.exec("DELETE FROM pithy_artifacts_tokens");
    expect(await artifactsStore(artifactsDatabase(env.DB)).tokenRecordsBegan()).toBeUndefined();
  });

  test("an idempotency key is spent once per connection, and two connections may each spend one", async () => {
    await artifacts_0001_init.up(db());
    await artifacts_0002_tokens.up(db());
    const insert = (connection: string) =>
      env.DB.prepare(
        "INSERT INTO pithy_artifacts_revocations (connection_id, idempotency_key, kind, repo, token_id, reason, revoked, created_at) VALUES (?, 'k1', 'all', 'r1', NULL, 'why', 0, 0)",
      )
        .bind(connection)
        .run();
    await insert("c1");
    await insert("c2");
    await expect(insert("c1")).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  test("down is the exact inverse of up, and leaves 0001 standing", async () => {
    await artifacts_0001_init.up(db());
    await artifacts_0002_tokens.up(db());
    await artifacts_0002_tokens.down?.(db());
    expect(await catalog()).toEqual([
      "pithy_artifacts_grants",
      "pithy_artifacts_grants_user_idx",
      "pithy_artifacts_repos",
      "pithy_artifacts_repos_owner_display_idx",
    ]);
    await artifacts_0002_tokens.up(db());
    expect(await catalog()).toContain("pithy_artifacts_tokens");
  });
});
