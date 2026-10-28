// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { AUTH_MIGRATION_ORDER } from "@pithy-sh/auth/src/migrations/0001_init";
import { AUTH_MIGRATIONS } from "@pithy-sh/auth/src/migrations/set";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { ForbiddenError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import type { SameOriginGate } from "@pithy-sh/core/src/http/sameOrigin";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { OrganizationConfig } from "../config/config";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import type { UserLifecycleWiring } from "../lifecycle/cascade";
import type { MemberRemovedEvent, MemberRoleChangedEvent } from "../lifecycle/hooks";
import type { EnqueueInvitation } from "../mail/invitation";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import type { OwnershipRoles } from "../ownership/ownership";
import { defineRoles } from "../roles/roles";
import { registerOrganizationRoutes } from "./routes";
import { ORGANIZATION_MEMBERS_WRITE_SCOPE, ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE } from "./scopes";

/**
 * The membership hooks over real D1, through a real Hono app: a role changed or a membership ended, through a
 * member's route or an operator's, each fired once with what changed.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const _BETA = "22222222-2222-4222-8222-222222222222";
const _ABSENT = "99999999-9999-4999-8999-999999999999";

const ADA = "user_ada";
const BOB = "user_bob";
const CAI = "user_cai";
const _DEE = "user_dee";

const SESSION = "session_main";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const _DAY = 24 * HOUR;
const BASE = "/organizations";
const ADMIN = `${BASE}/admin/organizations`;
const REASON = "Unpaid invoice 7781.";

const catalog = defineRoles({
  powers: ["connections:read"],
  roles: {
    member: ["organization:read", "connections:read"],
    admin: ["organization:read", "connections:read", "organization:manage"],
    owner: [
      "organization:read",
      "connections:read",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
    ],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin", "owner"],
  unassignable: ["owner"],
});

type Role = (typeof catalog.roles)[number];
const OWNERSHIP: OwnershipRoles<Role> = { confers: "owner", demotesTo: "admin" };

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

async function seedOrganization(id: string, name: string, slug: string): Promise<void> {
  await db()
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id, name, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
    .execute();
}

async function seedMembership(organizationId: string, userId: string, role: Role, joinedAfterMs = 0): Promise<void> {
  await db()
    .insertInto(MEMBERSHIPS_TABLE)
    .values(
      Membership.encode({
        id: crypto.randomUUID(),
        organizationId,
        userId,
        role,
        createdAt: new Date(NOW.getTime() + joinedAfterMs),
      }),
    )
    .execute();
}

let mailed: { to: string; template: string; payload: unknown }[] = [];
let events: AuditEventInput[] = [];
let roleChanges: MemberRoleChangedEvent[] = [];
let removals: MemberRemovedEvent[] = [];
let _refused: PithyError | null = null;

const enqueue: EnqueueInvitation = async (input) => {
  mailed.push({ to: input.to, template: input.template, payload: input.payload });
  return { jobId: "job-1", status: "queued" };
};

const emit: AuditEmit = async (event) => {
  events.push(event);
};

const allowAnyOrigin: SameOriginGate = async (_c, next) => {
  await next();
};

/** A management caller holding the scopes named. */
function verifierFor(granted: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  return async (_request, requirement) => {
    const scope = requirement as ControlPlaneScope;
    if (!granted.includes(scope)) throw new ForbiddenError({ message: "Scope not granted.", detail: `${scope}` });
    return {
      connectionId: "connection-1",
      environment: "test",
      issuer: "https://dashboard.example.test",
      subject: "operator-1",
      scope,
      grantedScopes: [...granted],
      keyId: "key-1",
      tokenId: "jti-1",
      actorKind: null,
    } satisfies ControlPlaneContext;
  };
}

/** What `@pithy-sh/auth` hands a cascade: its lifecycle config, every mail on, and no user hooks. */
const USERS: UserLifecycleWiring = {
  config: {
    retention: { purgeAfterDays: 30 },
    lifecycleEmails: {
      accountSuspended: true,
      accountReinstated: true,
      deletionScheduled: true,
      deletionComplete: true,
    },
  },
  hooks: {},
};

interface AppOptions {
  readonly config?: Partial<Parameters<typeof OrganizationConfig.parse>[0]>;
  readonly scopes?: readonly ControlPlaneScope[];
  readonly now?: Date;
  /** What this app's user lifecycle is: the auth wiring by default, `null` for a Worker that composes no auth. */
  readonly userLifecycle?: UserLifecycleWiring | null;
  /** The routes to mount, in place of the ones this file registers by hand — a composed capability's own. */
  readonly routes?: (app: Hono<PithyHonoEnv>) => void;
}

const LIFECYCLE_SCOPES = [ORGANIZATION_MEMBERS_WRITE_SCOPE] as const;

function buildApp(options: AppOptions = {}): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError((error, c) => {
    _refused = error instanceof PithyError ? error : null;
    return pithyErrorHandler(error, c);
  });
  app.use("*", async (c, next) => {
    const userId = c.req.header("x-test-user");
    c.set("auth", userId ? AuthContext.parse({ userId, sessionId: SESSION, scopes: [], locale: null }) : null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verifierFor(options.scopes ?? [...LIFECYCLE_SCOPES]));
    c.set("sameOrigin", allowAnyOrigin);
    c.set("emit", emit);
    c.set("log", noopLogger);
    await next();
  });
  if (options.routes) {
    options.routes(app);
    return app;
  }
  const at = options.now ?? NOW;
  const users = options.userLifecycle === null ? undefined : (options.userLifecycle ?? USERS);
  registerOrganizationRoutes({
    catalog,
    config: OrganizationConfig.parse({ baseUrl: "https://app.example.test", ...options.config }),
    ownership: OWNERSHIP,
    enqueue: () => enqueue,
    membershipHooks: {
      onMemberRoleChanged: (event) => void roleChanges.push(event),
      onMemberRemoved: (event) => void removals.push(event),
    },
    userLifecycle: () => users,
    now: () => at,
  })(app);
  return app;
}

let app: Hono<PithyHonoEnv>;

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; app?: Hono<PithyHonoEnv>; env?: Record<string, unknown> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.as) headers["x-test-user"] = options.as;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await (options.app ?? app).request(
    path,
    { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) },
    { DB: env.DB, ...options.env } as unknown as Record<string, unknown>,
  );
}

/** The membership a user holds in an organization. */
async function membershipOf(organizationId: string, userId: string): Promise<string> {
  const row = await db()
    .selectFrom(MEMBERSHIPS_TABLE)
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .executeTakeFirstOrThrow();
  return row.id;
}

async function choose(userId: string, organizationId: string): Promise<void> {
  expect((await call("POST", `${BASE}/acting`, { as: userId, body: { organizationId } })).status).toBe(200);
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  await seedUser(ADA, "ada@example.com");
  await seedUser(BOB, "bob@example.com");
  await seedUser(CAI, "cai@example.com");
  await seedOrganization(ACME, "Acme Games", "acme");
  await seedMembership(ACME, ADA, "owner", 0);
  await seedMembership(ACME, BOB, "admin", 1_000);
  await seedMembership(ACME, CAI, "member", 2_000);
  mailed = [];
  events = [];
  roleChanges = [];
  removals = [];
  _refused = null;
  app = buildApp();
});

describe("onMemberRoleChanged", () => {
  test("a demotion names the member, both roles, and the powers it took away", async () => {
    await choose(ADA, ACME);
    const bob = await membershipOf(ACME, BOB);
    const response = await call("PATCH", `${BASE}/current/members/${bob}`, { as: ADA, body: { role: "member" } });
    expect(response.status).toBe(200);
    expect(roleChanges).toEqual([
      {
        organizationId: ACME,
        membershipId: bob,
        userId: BOB,
        previousRole: "admin",
        role: "member",
        powersLost: ["organization:manage"],
        actor: { type: "member", userId: ADA },
        at: NOW,
      },
    ]);
  });

  test("a promotion fires too, and loses nothing", async () => {
    await choose(ADA, ACME);
    const cai = await membershipOf(ACME, CAI);
    expect((await call("PATCH", `${BASE}/current/members/${cai}`, { as: ADA, body: { role: "admin" } })).status).toBe(
      200,
    );
    expect(roleChanges).toMatchObject([{ userId: CAI, previousRole: "member", role: "admin", powersLost: [] }]);
  });

  test("an operator's role change fires, naming the management connection", async () => {
    const bob = await membershipOf(ACME, BOB);
    const response = await call("PATCH", `${ADMIN}/${ACME}/members/${bob}`, {
      body: { role: "member", reason: REASON },
    });
    expect(response.status).toBe(200);
    expect(roleChanges).toMatchObject([
      {
        userId: BOB,
        previousRole: "admin",
        role: "member",
        powersLost: ["organization:manage"],
        actor: { type: "control-plane", connectionId: "connection-1" },
      },
    ]);
  });

  test("a refused change fires nothing", async () => {
    await choose(CAI, ACME);
    const bob = await membershipOf(ACME, BOB);
    expect((await call("PATCH", `${BASE}/current/members/${bob}`, { as: CAI, body: { role: "member" } })).status).toBe(
      403,
    );
    expect(roleChanges).toEqual([]);
  });

  test("a hook that throws is logged and swallowed: the change stands", async () => {
    app = buildApp();
    const throwing = new Hono<PithyHonoEnv>();
    throwing.use("*", async (c, next) => {
      c.set("auth", AuthContext.parse({ userId: ADA, sessionId: SESSION, scopes: [], locale: null }));
      c.set("controlPlane", null);
      c.set("controlPlaneVerifier", verifierFor([]));
      c.set("sameOrigin", allowAnyOrigin);
      c.set("emit", emit);
      c.set("log", noopLogger);
      await next();
    });
    registerOrganizationRoutes({
      catalog,
      config: OrganizationConfig.parse({ baseUrl: "https://app.example.test" }),
      ownership: OWNERSHIP,
      membershipHooks: {
        onMemberRoleChanged: () => {
          throw new Error("the adopter's hook broke");
        },
      },
      now: () => NOW,
    })(throwing);
    await choose(ADA, ACME);
    const bob = await membershipOf(ACME, BOB);
    const response = await call("PATCH", `${BASE}/current/members/${bob}`, {
      as: ADA,
      body: { role: "member" },
      app: throwing,
    });
    expect(response.status).toBe(200);
  });
});

describe("onMemberRemoved", () => {
  test("a member removed by an administrator", async () => {
    await choose(ADA, ACME);
    const cai = await membershipOf(ACME, CAI);
    expect((await call("DELETE", `${BASE}/current/members/${cai}`, { as: ADA })).status).toBe(200);
    expect(removals).toEqual([
      {
        organizationId: ACME,
        membershipId: cai,
        userId: CAI,
        role: "member",
        left: false,
        actor: { type: "member", userId: ADA },
        at: NOW,
      },
    ]);
  });

  test("a member who leaves", async () => {
    await choose(CAI, ACME);
    const cai = await membershipOf(ACME, CAI);
    expect((await call("POST", `${BASE}/current/members/leave`, { as: CAI })).status).toBe(200);
    expect(removals).toMatchObject([{ membershipId: cai, userId: CAI, left: true }]);
  });

  test("a member removed by an operator", async () => {
    const cai = await membershipOf(ACME, CAI);
    const response = await call("DELETE", `${ADMIN}/${ACME}/members/${cai}`, { body: { reason: REASON } });
    expect(response.status).toBe(200);
    expect(removals).toMatchObject([
      { membershipId: cai, userId: CAI, left: false, actor: { type: "control-plane", connectionId: "connection-1" } },
    ]);
  });
});

describe("an ownership transfer", () => {
  const OWNER_POWERS_LOST = ["members:manage", "billing:manage", "organization:delete"];

  test("an accepted transfer demotes the previous holder and promotes the nominee, each fired once", async () => {
    await choose(ADA, ACME);
    const ada = await membershipOf(ACME, ADA);
    const bob = await membershipOf(ACME, BOB);
    expect((await call("POST", `${BASE}/current/ownership`, { as: ADA, body: { membershipId: bob } })).status).toBe(
      201,
    );
    await choose(BOB, ACME);
    expect((await call("POST", `${BASE}/ownership/accept`, { as: BOB })).status).toBe(200);
    expect(roleChanges).toHaveLength(2);
    expect(roleChanges[0]).toEqual({
      organizationId: ACME,
      membershipId: ada,
      userId: ADA,
      previousRole: "owner",
      role: "admin",
      powersLost: expect.arrayContaining(OWNER_POWERS_LOST),
      actor: { type: "member", userId: BOB },
      at: NOW,
    });
    expect(roleChanges[0]?.powersLost).toHaveLength(OWNER_POWERS_LOST.length);
    expect(roleChanges[1]).toMatchObject({
      membershipId: bob,
      userId: BOB,
      previousRole: "admin",
      role: "owner",
      powersLost: [],
      actor: { type: "member", userId: BOB },
    });
    expect(removals).toEqual([]);
  });

  test("an operator's forced transfer that keeps the previous owner demotes them and promotes the new holder", async () => {
    app = buildApp({ scopes: [ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE] });
    const ada = await membershipOf(ACME, ADA);
    const bob = await membershipOf(ACME, BOB);
    const response = await call("POST", `${ADMIN}/${ACME}/ownership`, {
      body: { membershipId: bob, previousOwner: "keep", reason: REASON },
    });
    expect(response.status).toBe(200);
    expect(roleChanges).toHaveLength(2);
    expect(roleChanges[0]).toMatchObject({
      membershipId: ada,
      userId: ADA,
      previousRole: "owner",
      role: "admin",
      actor: { type: "control-plane", connectionId: "connection-1" },
    });
    expect(roleChanges[0]?.powersLost).toEqual(expect.arrayContaining(OWNER_POWERS_LOST));
    expect(roleChanges[0]?.powersLost).toHaveLength(OWNER_POWERS_LOST.length);
    expect(roleChanges[1]).toMatchObject({
      membershipId: bob,
      userId: BOB,
      previousRole: "admin",
      role: "owner",
      powersLost: [],
      actor: { type: "control-plane", connectionId: "connection-1" },
    });
    expect(removals).toEqual([]);
  });

  test("an operator's forced transfer that removes the previous owner fires their removal and the promotion", async () => {
    app = buildApp({ scopes: [ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE] });
    const ada = await membershipOf(ACME, ADA);
    const bob = await membershipOf(ACME, BOB);
    const response = await call("POST", `${ADMIN}/${ACME}/ownership`, {
      body: { membershipId: bob, previousOwner: "remove", reason: REASON },
    });
    expect(response.status).toBe(200);
    expect(removals).toEqual([
      {
        organizationId: ACME,
        membershipId: ada,
        userId: ADA,
        role: "owner",
        left: false,
        actor: { type: "control-plane", connectionId: "connection-1" },
        at: NOW,
      },
    ]);
    expect(roleChanges).toMatchObject([
      {
        membershipId: bob,
        userId: BOB,
        previousRole: "admin",
        role: "owner",
        powersLost: [],
        actor: { type: "control-plane", connectionId: "connection-1" },
      },
    ]);
    expect(roleChanges).toHaveLength(1);
  });
});
