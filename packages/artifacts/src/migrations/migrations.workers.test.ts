// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { artifacts_0001_init } from "./0001_init";

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
