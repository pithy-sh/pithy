// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveInvitee } from "./resolve";

/**
 * `resolveInvitee` reads the `@pithy-sh/auth` `pithy_auth_users` table via a dynamic import. These tests
 * stand up that table with inline DDL and seed rows, then resolve by email (unique) and by name (ambiguous).
 */
beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_auth_users").run();
  await env.DB.prepare(
    `create table pithy_auth_users (
      id text primary key,
      name text,
      email text,
      email_verified integer,
      image text,
      created_at text,
      updated_at text
    )`,
  ).run();
});

const NOW = "2026-07-25T10:00:00.000Z";

async function insertUser(id: string, name: string, email: string): Promise<void> {
  await env.DB.prepare(
    `insert into pithy_auth_users (id, name, email, email_verified, image, created_at, updated_at)
     values (?, ?, ?, 1, null, ?, ?)`,
  )
    .bind(id, name, email, NOW, NOW)
    .run();
}

describe("resolveInvitee", () => {
  it("resolves a unique email to its user id", async () => {
    await insertUser("u-alice", "Alice", "alice@example.com");
    await insertUser("u-bob", "Bob", "bob@example.com");

    expect(await resolveInvitee(env.DB, { email: "alice@example.com" })).toBe("u-alice");
  });

  it("resolves a name that matches exactly one user", async () => {
    await insertUser("u-uniq", "Solo", "solo@example.com");
    expect(await resolveInvitee(env.DB, { name: "Solo" })).toBe("u-uniq");
  });

  it("an unknown email gives user_not_found", async () => {
    await insertUser("u-alice", "Alice", "alice@example.com");
    await expect(resolveInvitee(env.DB, { email: "ghost@example.com" })).rejects.toMatchObject({
      payload: { code: "matchmaking/user_not_found" },
    });
  });

  it("an ambiguous name gives user_not_found", async () => {
    await insertUser("u-1", "Twin", "one@example.com");
    await insertUser("u-2", "Twin", "two@example.com");
    await expect(resolveInvitee(env.DB, { name: "Twin" })).rejects.toMatchObject({
      payload: { code: "matchmaking/user_not_found" },
    });
  });

  it("requires exactly one of email or name", async () => {
    await expect(resolveInvitee(env.DB, {})).rejects.toMatchObject({
      payload: { code: "matchmaking/user_not_found" },
    });
    await expect(resolveInvitee(env.DB, { email: "a@example.com", name: "A" })).rejects.toMatchObject({
      payload: { code: "matchmaking/user_not_found" },
    });
  });
});
