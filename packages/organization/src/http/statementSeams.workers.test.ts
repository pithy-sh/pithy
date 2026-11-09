// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { AUTH_MIGRATION_ORDER } from "@pithy-sh/auth/src/migrations/0001_init";
import { AUTH_MIGRATIONS } from "@pithy-sh/auth/src/migrations/set";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { ForbiddenError } from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import type { SameOriginGate } from "@pithy-sh/core/src/http/sameOrigin";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { type OrganizationOptions, organization } from "../capability";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { invite } from "../invite/invite";
import type { MemberRoleChangedEvent } from "../lifecycle/hooks";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import type { MembershipJoined, OrganizationCreated, OrganizationStatement } from "../provision/provision";
import { defineRoles } from "../roles/roles";
import { ORGANIZATION_MEMBERS_WRITE_SCOPE } from "./scopes";

/**
 * `organization({ onCreate, onJoin })` through the composed capability's own routes, over real D1: the
 * founding, accepting and operator-add routes each write the adopter's rows in their batch, a failing
 * statement answers with an error and leaves nothing behind, and the audit events and membership hooks
 * are what they were.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const ADA = "user_ada";
const BOB = "user_bob";
const CAI = "user_cai";
const SESSION = "session_main";
const NOW = new Date("2026-11-01T12:00:00.000Z");
const BASE = "/organizations";
const REASON = "Support ticket 4410.";

const catalog = defineRoles({
  powers: ["connections:read"],
  roles: {
    member: ["organization:read", "connections:read"],
    admin: [
      "organization:read",
      "connections:read",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
    ],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin"],
});
type Role = (typeof catalog.roles)[number];

const TABLES = [
  "adopter_rows",
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
  "pithy_auth_verification_outcomes",
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

async function seedUser(id: string, email: string): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, image, locale, created_at, updated_at) values (?, ?, ?, 1, null, null, ?, ?)",
  )
    .bind(id, `Person ${id}`, email, NOW.toISOString(), NOW.toISOString())
    .run();
}

/** The adopter's own row, written by value. */
function row(d1: D1Database, kind: string, organizationId: string, membershipId: string | null): OrganizationStatement {
  return {
    compile: () =>
      sql`insert into adopter_rows (kind, organization_id, membership_id) values (${kind}, ${organizationId}, ${membershipId})`.compile(
        organizationDatabase(d1),
      ),
  };
}

/** A statement the adopter's own table refuses. */
function refused(d1: D1Database): OrganizationStatement {
  return { compile: () => sql`insert into adopter_rows (kind) values (null)`.compile(organizationDatabase(d1)) };
}

async function adopterRows(): Promise<{ kind: string; organization_id: string; membership_id: string | null }[]> {
  const { results } = await env.DB.prepare(
    "select kind, organization_id, membership_id from adopter_rows order by seq",
  ).all<{ kind: string; organization_id: string; membership_id: string | null }>();
  return results;
}

/** This capability's own audit actions, leaving out the control plane's record of each call. */
function organizationEvents(): string[] {
  return events.map((event) => event.action).filter((action) => action.startsWith("organization/"));
}

async function count(table: string): Promise<number> {
  const found = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
  return Number(found?.n ?? 0);
}

let events: AuditEventInput[] = [];
let created: OrganizationCreated[] = [];
let joined: MembershipJoined[] = [];
let roleChanges: MemberRoleChangedEvent[] = [];

const emit: AuditEmit = async (event) => {
  events.push(event);
};

const allowAnyOrigin: SameOriginGate = async (_c, next) => {
  await next();
};

/** The scopes the management caller holds. */
let granted: readonly ControlPlaneScope[] = [];

const verifier: ControlPlaneVerifier = async (_request, requirement) => {
  const scope = requirement as ControlPlaneScope;
  if (!granted.includes(scope)) {
    throw new ForbiddenError({ message: "Scope not granted.", detail: `${scope}` });
  }
  return {
    connectionId: "connection-1",
    environment: "test",
    issuer: "https://dashboard.example.test",
    subject: "operator-1",
    scope,
    grantedScopes: [scope],
    keyId: "key-1",
    tokenId: "jti-1",
    actorKind: null,
  } satisfies ControlPlaneContext;
};

/** The composed capability's routes, with the seams given, over a request context the test controls. */
function buildApp(seams: Pick<OrganizationOptions<string, Role>, "onCreate" | "onJoin">): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const userId = c.req.header("x-test-user");
    c.set("auth", userId ? AuthContext.parse({ userId, sessionId: SESSION, scopes: [], locale: null }) : null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verifier);
    c.set("sameOrigin", allowAnyOrigin);
    c.set("emit", emit);
    c.set("log", noopLogger);
    await next();
  });
  const composed = organization({
    roles: catalog,
    baseUrl: "https://app.example.test",
    sendInvitationEmail: false,
    ...seams,
    onMemberRoleChanged: (event) => void roleChanges.push(event),
  });
  composed.routes?.(app);
  return app;
}

async function call(
  app: Hono<PithyHonoEnv>,
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.as) headers["x-test-user"] = options.as;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await app.request(
    path,
    { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) },
    { DB: env.DB } as unknown as Record<string, unknown>,
  );
}

/** The seams every test composes unless it says otherwise: one row each, and a record of what each was told. */
const recording: Pick<OrganizationOptions<string, Role>, "onCreate" | "onJoin"> = {
  onCreate: (d1, event) => {
    created.push(event);
    return [row(d1, "settings", event.organizationId, null)];
  },
  onJoin: (d1, event) => {
    joined.push(event);
    return [row(d1, `joined:${event.via}`, event.organizationId, event.membershipId)];
  },
};

/** Makes the joining member `admin` in the join's batch, past the role they were let in at. */
const promote: Pick<OrganizationOptions<string, Role>, "onJoin"> = {
  onJoin: (d1, { membershipId }) => [
    {
      compile: () =>
        sql`update pithy_organization_memberships set role = 'admin' where id = ${membershipId}`.compile(
          organizationDatabase(d1),
        ),
    },
  ],
};

/** Each of this capability's own audit actions with the role it recorded. */
function rolesRecorded(): [string, unknown][] {
  return events
    .filter((event) => event.action.startsWith("organization/"))
    .map((event) => [event.action, (event.metadata as Record<string, unknown> | undefined)?.role]);
}

/** Acme, with Ada running it. */
async function acme(): Promise<void> {
  await db()
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id: ACME, name: "Acme", slug: "acme", logo: null, createdAt: NOW, updatedAt: NOW }))
    .execute();
  await db()
    .insertInto(MEMBERSHIPS_TABLE)
    .values(
      Membership.encode({ id: crypto.randomUUID(), organizationId: ACME, userId: ADA, role: "admin", createdAt: NOW }),
    )
    .execute();
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  await env.DB.prepare(
    "create table adopter_rows (seq integer primary key autoincrement, kind text not null, organization_id text not null, membership_id text)",
  ).run();
  await seedUser(ADA, "ada@example.com");
  await seedUser(BOB, "bob@example.com");
  await seedUser(CAI, "cai@example.com");
  events = [];
  created = [];
  joined = [];
  roleChanges = [];
  granted = [ORGANIZATION_MEMBERS_WRITE_SCOPE];
});

describe("founding", () => {
  test("writes onCreate's row and then onJoin's, founded, and records the founding as before", async () => {
    const response = await call(buildApp(recording), "POST", BASE, { as: ADA, body: { name: "Acme Games" } });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { organization: { id: string } };
    const organizationId = body.organization.id;
    const membership = await db()
      .selectFrom(MEMBERSHIPS_TABLE)
      .select("id")
      .where("organizationId", "=", organizationId)
      .executeTakeFirstOrThrow();

    expect(created).toEqual([{ organizationId, membershipId: membership.id, founderUserId: ADA, name: "Acme Games" }]);
    expect(joined).toEqual([
      { organizationId, membershipId: membership.id, userId: ADA, role: "admin", via: "founded", invitationId: null },
    ]);
    expect(await adopterRows()).toEqual([
      { kind: "settings", organization_id: organizationId, membership_id: null },
      { kind: "joined:founded", organization_id: organizationId, membership_id: membership.id },
    ]);
    expect(events.map((event) => event.action)).toEqual(["organization/created"]);
  });

  test("**a failing statement answers with an error and leaves no organization, membership or row**", async () => {
    const app = buildApp({
      onCreate: (d1, event) => [row(d1, "settings", event.organizationId, null), refused(d1)],
    });
    const response = await call(app, "POST", BASE, { as: ADA, body: { name: "Acme Games" } });
    expect(response.status).toBe(500);
    expect(await count("pithy_organization_organizations")).toBe(0);
    expect(await count("pithy_organization_memberships")).toBe(0);
    expect(await adopterRows()).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a caller the route refuses never reaches the builders", async () => {
    const response = await call(buildApp(recording), "POST", BASE, { body: { name: "Acme Games" } });
    expect(response.status).toBe(401);
    expect(created).toEqual([]);
    expect(joined).toEqual([]);
  });
});

describe("accepting an invitation", () => {
  test("writes onJoin's row with the invitation, and records the join as before", async () => {
    await acme();
    const minted = await invite(env.DB, catalog, {
      organizationId: ACME,
      email: "bob@example.com",
      role: "member",
      invitedByUserId: ADA,
      ttlDays: 7,
      // The composed routes read the real clock.
      now: new Date(),
    });
    const response = await call(buildApp(recording), "POST", `${BASE}/invitations/accept`, {
      as: BOB,
      body: { token: minted.token },
    });
    expect(response.status).toBe(200);
    const { membershipId } = (await response.json()) as { membershipId: string };

    expect(joined).toEqual([
      {
        organizationId: ACME,
        membershipId,
        userId: BOB,
        role: "member",
        via: "invitation",
        invitationId: minted.invitation.id,
      },
    ]);
    expect(await adopterRows()).toEqual([
      { kind: "joined:invitation", organization_id: ACME, membership_id: membershipId },
    ]);
    expect(events.map((event) => event.action)).toEqual(["organization/member_joined"]);
  });

  test("**an onJoin that promotes the member is answered and audited at the committed role**", async () => {
    await acme();
    const minted = await invite(env.DB, catalog, {
      organizationId: ACME,
      email: "bob@example.com",
      role: "member",
      invitedByUserId: ADA,
      ttlDays: 7,
      // The composed routes read the real clock.
      now: new Date(),
    });
    const response = await call(buildApp(promote), "POST", `${BASE}/invitations/accept`, {
      as: BOB,
      body: { token: minted.token },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { role: string }).role).toBe("admin");
    expect(rolesRecorded()).toEqual([["organization/member_joined", "admin"]]);
  });

  test("**a failing statement answers with an error, and the invitation still redeems afterwards**", async () => {
    await acme();
    const minted = await invite(env.DB, catalog, {
      organizationId: ACME,
      email: "bob@example.com",
      role: "member",
      invitedByUserId: ADA,
      ttlDays: 7,
      // The composed routes read the real clock.
      now: new Date(),
    });
    const failing = await call(buildApp({ onJoin: (d1) => [refused(d1)] }), "POST", `${BASE}/invitations/accept`, {
      as: BOB,
      body: { token: minted.token },
    });
    expect(failing.status).toBe(500);
    expect(await count("pithy_organization_memberships")).toBe(1);
    expect(events).toEqual([]);

    const retried = await call(buildApp(recording), "POST", `${BASE}/invitations/accept`, {
      as: BOB,
      body: { token: minted.token },
    });
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { joined: boolean }).joined).toBe(true);
  });
});

describe("an operator's add", () => {
  test("writes onJoin's row as the operator's, records the add as before, and a later role change still fires its hook", async () => {
    await acme();
    const app = buildApp(recording);
    const response = await call(app, "POST", `${BASE}/admin/organizations/${ACME}/members`, {
      body: { userId: CAI, role: "member", reason: REASON },
    });
    expect(response.status).toBe(201);
    const { member } = (await response.json()) as { member: { membershipId: string } };

    expect(joined).toEqual([
      {
        organizationId: ACME,
        membershipId: member.membershipId,
        userId: CAI,
        role: "member",
        via: "operator",
        invitationId: null,
      },
    ]);
    expect(await adopterRows()).toEqual([
      { kind: "joined:operator", organization_id: ACME, membership_id: member.membershipId },
    ]);
    expect(organizationEvents()).toEqual(["organization/admin_member_added"]);

    const changed = await call(app, "PATCH", `${BASE}/admin/organizations/${ACME}/members/${member.membershipId}`, {
      body: { role: "admin", reason: REASON },
    });
    expect(changed.status).toBe(200);
    expect(roleChanges.map((event) => [event.membershipId, event.role])).toEqual([[member.membershipId, "admin"]]);
  });

  test("**an onJoin that promotes the member is answered and audited at the committed role**", async () => {
    await acme();
    const response = await call(buildApp(promote), "POST", `${BASE}/admin/organizations/${ACME}/members`, {
      body: { userId: CAI, role: "member", reason: REASON },
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { member: { role: string } }).member.role).toBe("admin");
    expect(rolesRecorded()).toEqual([["organization/admin_member_added", "admin"]]);
  });

  test("**a failing statement answers with an error and leaves no membership**", async () => {
    await acme();
    const response = await call(
      buildApp({ onJoin: (d1) => [refused(d1)] }),
      "POST",
      `${BASE}/admin/organizations/${ACME}/members`,
      {
        body: { userId: CAI, role: "member", reason: REASON },
      },
    );
    expect(response.status).toBe(500);
    expect(await count("pithy_organization_memberships")).toBe(1);
    expect(organizationEvents()).toEqual([]);
  });

  test("a caller without the roster scope never reaches the builder", async () => {
    await acme();
    granted = [];
    const response = await call(buildApp(recording), "POST", `${BASE}/admin/organizations/${ACME}/members`, {
      body: { userId: CAI, role: "member", reason: REASON },
    });
    expect(response.status).toBe(403);
    expect(joined).toEqual([]);
    expect(await count("pithy_organization_memberships")).toBe(1);
  });
});
