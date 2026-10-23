// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { authDatabase } from "@pithy-sh/auth/src/data/tables";
import type { LifecycleDeps } from "@pithy-sh/auth/src/lifecycle/transitions";
import { AUTH_MIGRATION_ORDER } from "@pithy-sh/auth/src/migrations/0001_init";
import { AUTH_MIGRATIONS } from "@pithy-sh/auth/src/migrations/set";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import { classifyMembers, deleteSoleMembers, membersStillShut, suspendSoleMembers } from "./cascade";

/**
 * The member cascade (#623) over real D1 and `@pithy-sh/auth`'s own transitions: who it reaches, who it never
 * touches, and what it reports for each.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-23T12:00:00.000Z");

const TABLES = [
  "pithy_organization_lifecycle",
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_user_lifecycle",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_migrations",
  "pithy_migrations_lock",
];

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    {
      database: "app",
      namespace: "organization",
      order: ORGANIZATION_MIGRATION_ORDER,
      migrations: ORGANIZATION_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => organizationDatabase(env.DB);

function users(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    db: authDatabase(env.DB),
    d1: env.DB,
    emit: noopEmit,
    config: {
      retention: { purgeAfterDays: 30 },
      lifecycleEmails: {
        accountSuspended: false,
        accountReinstated: false,
        deletionScheduled: false,
        deletionComplete: false,
      },
    },
    hooks: {},
    now: () => NOW,
    ...overrides,
  };
}

const ACTOR = { type: "control-plane", id: "operator-1" } as const;

async function seedUser(id: string): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, image, locale, created_at, updated_at) values (?, ?, ?, 1, null, null, ?, ?)",
  )
    .bind(id, id, `${id}@example.com`, NOW.toISOString(), NOW.toISOString())
    .run();
}

async function member(organizationId: string, userId: string): Promise<void> {
  await db()
    .insertInto(MEMBERSHIPS_TABLE)
    .values(Membership.encode({ id: crypto.randomUUID(), organizationId, userId, role: "member", createdAt: NOW }))
    .execute();
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  for (const [id, slug] of [
    [ACME, "acme"],
    [BETA, "beta"],
  ] as const) {
    await db()
      .insertInto(ORGANIZATIONS_TABLE)
      .values(Organization.encode({ id, name: slug, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
      .execute();
  }
  // Ada is in both; Bob and Cai in Acme alone; "ghost" has a membership and no account.
  for (const id of ["ada", "bob", "cai"]) await seedUser(id);
  await member(ACME, "ada");
  await member(BETA, "ada");
  await member(ACME, "bob");
  await member(ACME, "cai");
  await member(ACME, "ghost");
});

describe("classifyMembers", () => {
  test("splits an organization's members by whether they belong to any other", async () => {
    expect(await classifyMembers(db(), ACME)).toEqual({ sole: ["bob", "cai", "ghost"], elsewhere: ["ada"] });
    expect(await classifyMembers(db(), BETA)).toEqual({ sole: [], elsewhere: ["ada"] });
  });

  test("another organization counts whatever state it is in", async () => {
    await db().updateTable(ORGANIZATIONS_TABLE).set({ deletedAt: NOW.getTime() }).where("id", "=", BETA).execute();
    expect((await classifyMembers(db(), ACME)).elsewhere).toEqual(["ada"]);
  });
});

describe("suspendSoleMembers", () => {
  const deps = () => ({ db: db(), users: users(), actor: ACTOR, now: NOW });

  test("none reaches nobody and reads nothing", async () => {
    expect(await suspendSoleMembers(deps(), { organizationId: ACME, mode: "none", reason: "r", until: null })).toEqual({
      mode: "none",
      reached: [],
      skipped: [],
    });
  });

  test("sole reaches only the sole members, and names why each other was left alone", async () => {
    const outcome = await suspendSoleMembers(deps(), { organizationId: ACME, mode: "sole", reason: "r", until: null });
    expect(outcome).toEqual({
      mode: "sole",
      reached: [
        { userId: "bob", outcome: "suspended" },
        { userId: "cai", outcome: "suspended" },
      ],
      skipped: [
        { userId: "ada", reason: "member_elsewhere" },
        { userId: "ghost", reason: "no_account" },
      ],
    });
  });

  test("an account already suspended keeps its own suspension, and one already deleted is left alone", async () => {
    await env.DB.prepare("update pithy_auth_users set deleted_at = ? where id = 'bob'").bind(NOW.getTime()).run();
    await env.DB.prepare("update pithy_auth_users set suspended_at = ? where id = 'cai'")
      .bind(NOW.getTime() - 1)
      .run();
    const outcome = await suspendSoleMembers(deps(), { organizationId: ACME, mode: "sole", reason: "r", until: null });
    expect(outcome.reached).toEqual([]);
    expect(outcome.skipped).toEqual([
      { userId: "ada", reason: "member_elsewhere" },
      { userId: "bob", reason: "account_deleted" },
      { userId: "cai", reason: "already_suspended" },
      { userId: "ghost", reason: "no_account" },
    ]);
    const cai = await env.DB.prepare("select suspended_at from pithy_auth_users where id = 'cai'").first<{
      suspended_at: number;
    }>();
    expect(cai?.suspended_at).toBe(NOW.getTime() - 1);
  });
});

describe("deleteSoleMembers", () => {
  test("deletes the sole members' accounts, and tells the caller each one a hard deletion reached", async () => {
    const hard: string[] = [];
    const outcome = await deleteSoleMembers(
      { db: db(), users: users(), actor: ACTOR, now: NOW },
      {
        organizationId: ACME,
        mode: "sole",
        reason: "r",
        deletion: "hard",
        onHard: async (userId) => void hard.push(userId),
      },
    );
    expect(outcome.reached).toEqual([
      { userId: "bob", outcome: "deleted" },
      { userId: "cai", outcome: "deleted" },
    ]);
    expect(hard).toEqual(["bob", "cai"]);
  });

  test("a failure on one member is reported, and does not stop the next", async () => {
    const outcome = await deleteSoleMembers(
      { db: db(), users: users(), actor: ACTOR, now: NOW },
      {
        organizationId: ACME,
        mode: "sole",
        reason: "r",
        deletion: "hard",
        onHard: async (userId) => {
          if (userId === "bob") throw new Error("purge binding broke");
        },
      },
    );
    expect(outcome.reached).toEqual([{ userId: "cai", outcome: "deleted" }]);
    expect(outcome.skipped).toContainEqual({ userId: "bob", reason: "failed" });
  });
});

describe("membersStillShut", () => {
  test("names each member whose own account is suspended or deleted, and nobody else", async () => {
    await env.DB.prepare("update pithy_auth_users set suspended_at = ? where id = 'bob'").bind(NOW.getTime()).run();
    await env.DB.prepare("update pithy_auth_users set deleted_at = ? where id = 'cai'").bind(NOW.getTime()).run();
    expect(await membersStillShut(db(), authDatabase(env.DB), ACME, NOW)).toEqual([
      { userId: "bob", state: "suspended" },
      { userId: "cai", state: "deleted" },
    ]);
  });
});
