// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import { defineRoles, ORGANIZATION_POWERS } from "../roles/roles";
import { chooseActing } from "./acting";
import { actingOrganizationMiddleware } from "./seam";

/**
 * Core's acting-organization seam, filled by tenancy. Media and storage scope every record through it, so
 * the answer it gives must be the one `requireOrganization` gives: the session's selection, rejoined
 * against a live membership, with the role's powers asked of the catalog.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ADMIN = "user_admin";
const MEMBER = "user_member";
const NOW = new Date("2026-10-16T12:00:00.000Z");

const catalog = defineRoles({
  roles: {
    member: ["organization:read"],
    admin: [...ORGANIZATION_POWERS, "media:manage"],
  },
  administrativePower: "organization:manage",
});

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
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

beforeEach(async () => {
  for (const table of [
    "pithy_organization_lifecycle",
    "pithy_organization_acting",
    "pithy_organization_ownership_nominations",
    "pithy_organization_invitations",
    "pithy_organization_memberships",
    "pithy_organization_organizations",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
  for (const [id, name, slug] of [
    [ACME, "Acme", "acme"],
    [BETA, "Beta", "beta"],
  ] as const) {
    await db()
      .insertInto(ORGANIZATIONS_TABLE)
      .values(Organization.encode({ id, name, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
      .execute();
  }
  for (const [organizationId, userId, role] of [
    [ACME, ADMIN, "admin"],
    [ACME, MEMBER, "member"],
  ] as const) {
    await db()
      .insertInto(MEMBERSHIPS_TABLE)
      .values(Membership.encode({ id: crypto.randomUUID(), organizationId, userId, role, createdAt: NOW }))
      .execute();
  }
});

/** An app that signs a caller in from `x-user`, then publishes the seam — in that order or the other. */
function app(order: "auth-first" | "organization-first" = "auth-first") {
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  const signIn = (h: Hono<PithyHonoEnv>) =>
    h.use("*", async (c, next) => {
      const user = c.req.header("x-user");
      c.set("auth", user ? { userId: user, sessionId: `session-${user}`, scopes: [] } : null);
      await next();
    });
  if (order === "auth-first") signIn(hono);
  actingOrganizationMiddleware(catalog)(hono);
  if (order === "organization-first") signIn(hono);
  hono.get("/acting", async (c) => {
    const acting = await c.var.actingOrganization();
    return c.json({
      organizationId: acting?.organizationId ?? null,
      mediaManage: acting?.roleAllows("media:manage") ?? null,
      storageManage: acting?.roleAllows("storage:manage") ?? null,
      undeclared: acting?.roleAllows("projects:manage") ?? null,
    });
  });
  return hono;
}

async function ask(user: string | null, order?: "auth-first" | "organization-first") {
  const res = await app(order).request("/acting", user ? { headers: { "x-user": user } } : {}, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the acting-organization seam, filled by tenancy", () => {
  test("an anonymous request has no organization in force", async () => {
    expect((await ask(null)).body.organizationId).toBeNull();
  });

  test("a session that has chosen nothing has no organization in force", async () => {
    expect((await ask(ADMIN)).body.organizationId).toBeNull();
  });

  test("a chosen organization is in force, with the role's powers asked of the catalog", async () => {
    await chooseActing(db(), { userId: ADMIN, sessionId: `session-${ADMIN}`, organizationId: ACME, now: NOW });
    expect((await ask(ADMIN)).body).toEqual({
      organizationId: ACME,
      mediaManage: true,
      storageManage: false,
      undeclared: false,
    });
  });

  test("a member's role answers for the member, not for the admin beside them", async () => {
    await chooseActing(db(), { userId: MEMBER, sessionId: `session-${MEMBER}`, organizationId: ACME, now: NOW });
    expect((await ask(MEMBER)).body).toMatchObject({ organizationId: ACME, mediaManage: false });
  });

  test("a revoked membership stops being in force on the next request", async () => {
    await chooseActing(db(), { userId: MEMBER, sessionId: `session-${MEMBER}`, organizationId: ACME, now: NOW });
    await db().deleteFrom(MEMBERSHIPS_TABLE).where("userId", "=", MEMBER).execute();
    expect((await ask(MEMBER)).body.organizationId).toBeNull();
  });

  test("composition order does not matter — the session is read when the seam is asked", async () => {
    await chooseActing(db(), { userId: ADMIN, sessionId: `session-${ADMIN}`, organizationId: ACME, now: NOW });
    expect((await ask(ADMIN, "organization-first")).body.organizationId).toBe(ACME);
  });
});
