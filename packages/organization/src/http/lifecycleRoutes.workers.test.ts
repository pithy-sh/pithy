// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { AUTH_MIGRATION_ORDER } from "@pithy-sh/auth/src/migrations/0001_init";
import { AUTH_MIGRATIONS } from "@pithy-sh/auth/src/migrations/set";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { forgetComposition, recordComposition } from "@pithy-sh/core/src/capability/composition";
import type { PurgeDeletion, PurgeStep } from "@pithy-sh/core/src/capability/purge";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { ForbiddenError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import type { SameOriginGate } from "@pithy-sh/core/src/http/sameOrigin";
import { validate } from "@pithy-sh/core/src/http/validation";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { WorkflowStepLike } from "@pithy-sh/core/src/workflow/faults";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { organization } from "../capability";
import { OrganizationConfig } from "../config/config";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import {
  ACTING_TABLE,
  LIFECYCLE_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
import type { UserLifecycleWiring } from "../lifecycle/cascade";
import { organizationErasureReader } from "../lifecycle/erasure";
import type { OrganizationLifecycleHookEvent } from "../lifecycle/hooks";
import { deleteOrganizationAsOwner, OWNER_DELETE_REASON } from "../lifecycle/ownerDelete";
import type { EnqueueInvitation } from "../mail/invitation";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import type { OwnershipRoles } from "../ownership/ownership";
import { organizationPurgeContribution } from "../purge/contribution";
import { organizationPurgeOps, purgeOrganization } from "../purge/run";
import { ORGANIZATION_PURGE_BINDING } from "../purge/specs";
import { defineRoles } from "../roles/roles";
import { type OrganizationHonoEnv, requireOrganization } from "./guard";
import {
  AdminMemberCascadePreviewResponse,
  AdminOrganizationDeleteResponse,
  AdminOrganizationReinstateResponse,
  AdminOrganizationRestoreResponse,
  AdminOrganizationSuspendResponse,
  AdminOrganizationsResponse,
  DeletedOrganizationResponse,
} from "./responses";
import { registerOrganizationRoutes } from "./routes";
import {
  ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
  ORGANIZATION_ACCOUNTS_READ_SCOPE,
  ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
  ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
  ORGANIZATION_MEMBERS_WRITE_SCOPE,
} from "./scopes";

/**
 * The organization lifecycle, over real D1, through a real Hono app with the real error codec — the four
 * control-plane routes, and what a suspension or deletion means at every door a member uses.
 *
 * The cast: Acme holds Ada (owner, also a member of Beta), Bob (admin, Acme only) and Cai (member, Acme only). So
 * a `members: "sole"` cascade must reach Bob and Cai and never Ada, and Ada must carry on in Beta whatever is
 * done to Acme. The user lifecycle is `@pithy-sh/auth`'s own, over its own migrations, so a reached account is
 * asserted on its own columns and history.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ABSENT = "99999999-9999-4999-8999-999999999999";

const ADA = "user_ada";
const BOB = "user_bob";
const CAI = "user_cai";
const DEE = "user_dee";

const SESSION = "session_main";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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
  "pithy_organization_foundings",
  "pithy_organization_lifecycle",
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "pithy_auth_accounts",
  "pithy_auth_app_attest_keys",
  "pithy_auth_attestation_challenges",
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
let hooked: { name: string; event: OrganizationLifecycleHookEvent }[] = [];
let refused: PithyError | null = null;

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

const LIFECYCLE_SCOPES = [ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE, ORGANIZATION_ACCOUNTS_DELETE_SCOPE] as const;

/** A capability's own route mount, loaded, for `buildApp` to put behind the test middleware. */
async function mountOf(capability: Capability): Promise<(app: Hono<PithyHonoEnv>) => void> {
  const mount = await capability.routes?.load();
  if (mount === undefined) throw new Error("expected the capability to contribute routes");
  return (app) => mount(app, { composed: app });
}

function buildApp(options: AppOptions = {}): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError((error, c) => {
    refused = error instanceof PithyError ? error : null;
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
    lifecycleHooks: {
      onOrganizationSuspended: (event) => void hooked.push({ name: "suspended", event }),
      onOrganizationReinstated: (event) => void hooked.push({ name: "reinstated", event }),
      onOrganizationDeleted: (event) => void hooked.push({ name: "deleted", event }),
      onOrganizationRestored: (event) => void hooked.push({ name: "restored", event }),
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
  options: {
    as?: string;
    body?: unknown;
    /** Sent verbatim under a JSON content type, for a body that is not a serialized value. */
    rawBody?: string;
    app?: Hono<PithyHonoEnv>;
    env?: Record<string, unknown>;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.as) headers["x-test-user"] = options.as;
  if (options.body !== undefined || options.rawBody !== undefined) headers["content-type"] = "application/json";
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return await (options.app ?? app).request(
    path,
    { method, headers, ...(body === undefined ? {} : { body }) },
    { DB: env.DB, ...options.env } as unknown as Record<string, unknown>,
    options.executionCtx as never,
  );
}

/** A response body, parsed with the schema the route declares — and equal to what came over the wire. */
async function bound<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  const body = (await response.json()) as unknown;
  const parsed = schema.parse(body);
  expect(parsed).toEqual(body);
  return parsed;
}

async function errorOf(response: Response): Promise<{ code: string; params?: Record<string, unknown> }> {
  return ((await response.json()) as { error: { code: string; params?: Record<string, unknown> } }).error;
}

/** Which organizations a member's chooser lists. */
async function listed(userId: string, using = app): Promise<string[]> {
  const body = (await (await call("GET", BASE, { as: userId, app: using })).json()) as {
    organizations: { id: string }[];
  };
  return body.organizations.map((organization) => organization.id);
}

async function choose(userId: string, organizationId: string, using = app): Promise<Response> {
  return call("POST", `${BASE}/acting`, { as: userId, body: { organizationId }, app: using });
}

async function selection(): Promise<string | undefined> {
  const row = await db()
    .selectFrom(ACTING_TABLE)
    .select("organizationId")
    .where("sessionId", "=", SESSION)
    .executeTakeFirst();
  return row?.organizationId;
}

/** A person's own account columns, as auth stores them. */
async function account(userId: string): Promise<{ suspended_at: number | null; deleted_at: number | null }> {
  const row = await env.DB.prepare("select suspended_at, deleted_at from pithy_auth_users where id = ?")
    .bind(userId)
    .first<{ suspended_at: number | null; deleted_at: number | null }>();
  if (!row) throw new Error(`no account ${userId}`);
  return row;
}

function operatorEvent(action: string): AuditEventInput {
  const found = events.filter((event) => event.action === action);
  expect(found, action).toHaveLength(1);
  return found[0] as AuditEventInput;
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());

  await seedUser(ADA, "ada@example.com");
  await seedUser(BOB, "bob@example.com");
  await seedUser(CAI, "cai@example.com");
  await seedUser(DEE, "dee@example.com");
  await seedOrganization(ACME, "Acme Games", "acme");
  await seedOrganization(BETA, "Beta Studio", "beta");
  await seedMembership(ACME, ADA, "owner", 0);
  await seedMembership(ACME, BOB, "admin", 1_000);
  await seedMembership(ACME, CAI, "member", 2_000);
  await seedMembership(BETA, ADA, "member");
  await seedMembership(BETA, DEE, "owner", 1_000);

  mailed = [];
  events = [];
  hooked = [];
  refused = null;
  app = buildApp();
});

describe("the gate", () => {
  /** Every lifecycle route, well formed, with the scope it demands. */
  function everyRoute(organizationId = ACME): { method: string; path: string; body: unknown; scope: string }[] {
    return [
      {
        method: "POST",
        path: `${ADMIN}/${organizationId}/suspend`,
        body: { reason: REASON },
        scope: ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
      },
      {
        method: "POST",
        path: `${ADMIN}/${organizationId}/reinstate`,
        body: { reason: REASON },
        scope: ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
      },
      {
        method: "DELETE",
        path: `${ADMIN}/${organizationId}`,
        body: { reason: REASON },
        scope: ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
      },
      {
        method: "POST",
        path: `${ADMIN}/${organizationId}/restore`,
        body: { reason: REASON },
        scope: ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
      },
    ];
  }

  test("each route demands its own lifecycle scope; every other scope, the writes included, is 403 and changes nothing", async () => {
    for (const route of everyRoute()) {
      const others = buildApp({
        scopes: [
          ORGANIZATION_ACCOUNTS_READ_SCOPE,
          ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
          ORGANIZATION_MEMBERS_WRITE_SCOPE,
          ...LIFECYCLE_SCOPES.filter((scope) => scope !== route.scope),
        ],
      });
      const response = await call(route.method, route.path, { app: others, body: route.body });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
    const row = await db().selectFrom(ORGANIZATIONS_TABLE).selectAll().where("id", "=", ACME).executeTakeFirstOrThrow();
    expect([row.suspendedAt, row.deletedAt]).toEqual([null, null]);
  });

  test("every route takes a required reason", async () => {
    for (const route of everyRoute()) {
      const response = await call(route.method, route.path, { body: {} });
      expect(response.status, `${route.method} ${route.path}`).toBe(400);
      expect((await errorOf(response)).code).toBe("validation/invalid_input");
    }
  });

  test("an unknown organization is a 404 on every route, never a 403", async () => {
    for (const route of everyRoute(ABSENT)) {
      const response = await call(route.method, route.path, { body: route.body });
      expect(response.status, `${route.method} ${route.path}`).toBe(404);
      expect((await errorOf(response)).code).toBe("organization/not_found");
    }
  });

  test("every route writes an audit event with the operator, the connection and the reason", async () => {
    const actions = {
      [`POST ${ADMIN}/${ACME}/suspend`]: "organization/admin_organization_suspended",
      [`POST ${ADMIN}/${ACME}/reinstate`]: "organization/admin_organization_reinstated",
      [`DELETE ${ADMIN}/${ACME}`]: "organization/admin_organization_deleted",
      [`POST ${ADMIN}/${ACME}/restore`]: "organization/admin_organization_restored",
    } as Record<string, string>;
    for (const route of everyRoute()) {
      events = [];
      const response = await call(route.method, route.path, { body: route.body });
      expect(response.status, `${route.method} ${route.path}`).toBe(200);
      const action = actions[`${route.method} ${route.path}`] ?? "";
      expect(operatorEvent(action)).toMatchObject({
        actorType: "control-plane",
        actorId: "operator-1",
        tenant: ACME,
        resourceType: "organization",
        resourceId: ACME,
        metadata: expect.objectContaining({ connectionId: "connection-1", reason: REASON }),
      });
    }
  });
});

describe("suspending an organization", () => {
  test("refuses a member's request to act in it with organization/organization_suspended, 403, and clears their selection", async () => {
    expect((await choose(CAI, ACME)).status).toBe(200);
    expect((await call("GET", `${BASE}/current`, { as: CAI })).status).toBe(200);

    const response = await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    expect(response.status).toBe(200);
    const body = await bound(response, AdminOrganizationSuspendResponse);
    expect(body).toMatchObject({ organizationId: ACME, changed: true, updated: false, suspendedUntil: null });
    expect(body.suspendedAt).toBe(NOW.toISOString());

    const refusedNow = await call("GET", `${BASE}/current`, { as: CAI });
    expect(refusedNow.status).toBe(403);
    expect((await errorOf(refusedNow)).code).toBe("organization/organization_suspended");
    // The selection went with the refusal, so the next request finds nothing in force rather than the same 403.
    expect(await selection()).toBeUndefined();
    expect((await call("GET", `${BASE}/current`, { as: CAI })).status).toBe(404);
    // And it cannot be chosen again while it is suspended.
    const chosen = await choose(CAI, ACME);
    expect(chosen.status).toBe(403);
    expect((await errorOf(chosen)).code).toBe("organization/organization_suspended");
  });

  test("a route naming the suspended organization refuses its member 403, and a stranger still gets the 404", async () => {
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    const member = await call("GET", `${BASE}/marks/organization/${ACME}`, { as: CAI });
    expect(member.status).toBe(403);
    expect((await errorOf(member)).code).toBe("organization/organization_suspended");
    const stranger = await call("GET", `${BASE}/marks/organization/${ACME}`, { as: DEE });
    expect(stranger.status).toBe(404);
    expect((await errorOf(stranger)).code).toBe("organization/not_found");
  });

  test("it leaves every member's list, and a member of another organization carries on there unchanged", async () => {
    expect(await listed(ADA)).toEqual([ACME, BETA]);
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON, members: "sole" } });
    expect(await listed(ADA)).toEqual([BETA]);
    expect(await listed(CAI)).toEqual([]);
    // Ada belongs to Beta too, so the cascade never touched her account, and Beta is hers to act in.
    expect(await account(ADA)).toEqual({ suspended_at: null, deleted_at: null });
    expect((await choose(ADA, BETA)).status).toBe(200);
    const current = await call("GET", `${BASE}/current`, { as: ADA });
    expect(current.status).toBe(200);
    expect(((await current.json()) as { organization: { id: string } }).organization.id).toBe(BETA);
  });

  test("a member whose only organization is suspended is told so by the list, after the selection is gone too", async () => {
    expect((await choose(CAI, ACME)).status).toBe(200);
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    // The request that finds the selection clears it, and every later one finds nothing in force.
    expect((await call("GET", `${BASE}/current`, { as: CAI })).status).toBe(403);
    expect(await selection()).toBeUndefined();
    const body = (await (await call("GET", BASE, { as: CAI })).json()) as Record<string, unknown>;
    // Not "you belong nowhere": the chooser routes on the count to the suspended screen.
    expect(body).toEqual({ organizations: [], acting: null, chosen: false, suspended: 1 });
    // Ada belongs to Beta as well, so her list still offers it, and says Acme is the suspended one.
    const ada = (await (await call("GET", BASE, { as: ADA })).json()) as { suspended: number };
    expect(ada.suspended).toBe(1);
    // A stranger to Acme is told nothing about it.
    const dee = (await (await call("GET", BASE, { as: DEE })).json()) as { suspended: number };
    expect(dee.suspended).toBe(0);
  });

  test("a deleted organization is not counted as suspended: it is gone from the list altogether", async () => {
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } });
    const body = (await (await call("GET", BASE, { as: CAI })).json()) as Record<string, unknown>;
    expect(body).toEqual({ organizations: [], acting: null, chosen: false, suspended: 0 });
  });

  test("an invitation to it can be neither read nor accepted, and the offer stays pending", async () => {
    await choose(ADA, ACME);
    await call("POST", `${BASE}/current/invitations`, { as: ADA, body: { email: "eve@example.com", role: "member" } });
    const mail = mailed.find((entry) => entry.template === "invite");
    const url = (mail?.payload as { acceptUrl?: string } | undefined)?.acceptUrl ?? "";
    const token = decodeURIComponent(url.split("/").pop() ?? "");
    expect(token).not.toBe("");
    await seedUser("user_eve", "eve@example.com");
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });

    const offer = await call("GET", `${BASE}/invitations/${token}`);
    expect(offer.status).toBe(400);
    expect((await errorOf(offer)).code).toBe("organization/invitation_invalid");
    const accept = await call("POST", `${BASE}/invitations/accept`, { as: "user_eve", body: { token } });
    expect(accept.status).toBe(400);
    expect((await errorOf(accept)).code).toBe("organization/invitation_invalid");
    const joined = await db().selectFrom(MEMBERSHIPS_TABLE).select("id").where("userId", "=", "user_eve").execute();
    expect(joined).toEqual([]);
    expect(events.map((event) => event.action)).not.toContain("organization/member_joined");
  });

  test("an owner the sole cascade reached gets their own account's notice, never the one saying it is unaffected", async () => {
    // Dee owns Beta and belongs nowhere else, so `members: "sole"` reaches her own account.
    await call("POST", `${ADMIN}/${BETA}/suspend`, { body: { reason: REASON, members: "sole" } });
    expect((await account(DEE)).suspended_at).toBe(NOW.getTime());
    expect(mailed.filter((mail) => mail.to === "dee@example.com").map((mail) => mail.template)).toEqual([
      "accountSuspended",
    ]);
  });

  test("members defaults to none, and no member's account is touched by omission", async () => {
    const body = await bound(
      await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } }),
      AdminOrganizationSuspendResponse,
    );
    expect(body.members).toEqual({ mode: "none", reached: [], skipped: [] });
    for (const userId of [ADA, BOB, CAI])
      expect(await account(userId)).toEqual({ suspended_at: null, deleted_at: null });
    const history = await env.DB.prepare("select count(*) as n from pithy_auth_user_lifecycle").first<{ n: number }>();
    expect(history?.n).toBe(0);
  });

  test("members: sole suspends only the members whose only organization this is, through the user lifecycle, with the organization's reason", async () => {
    const body = await bound(
      await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON, members: "sole" } }),
      AdminOrganizationSuspendResponse,
    );
    expect(body.members).toEqual({
      mode: "sole",
      reached: [
        { userId: BOB, outcome: "suspended" },
        { userId: CAI, outcome: "suspended" },
      ],
      skipped: [{ userId: ADA, reason: "member_elsewhere" }],
    });
    expect((await account(BOB)).suspended_at).toBe(NOW.getTime());
    expect((await account(CAI)).suspended_at).toBe(NOW.getTime());
    expect(await account(ADA)).toEqual({ suspended_at: null, deleted_at: null });
    // Through auth's own transition: its history row, its audit event, its mail — the organization's reason on each.
    const { results } = await env.DB.prepare(
      "select user_id, action, actor_type, actor_id, reason from pithy_auth_user_lifecycle order by user_id",
    ).all();
    expect(results).toEqual([
      { user_id: BOB, action: "suspended", actor_type: "control-plane", actor_id: "operator-1", reason: REASON },
      { user_id: CAI, action: "suspended", actor_type: "control-plane", actor_id: "operator-1", reason: REASON },
    ]);
    expect(
      events.filter((event) => event.action === "auth/admin_user_suspended").map((event) => event.resourceId),
    ).toEqual([BOB, CAI]);
    expect(mailed.filter((mail) => mail.template === "accountSuspended").map((mail) => mail.to)).toEqual([
      "bob@example.com",
      "cai@example.com",
    ]);
    // The trail holds counts, never the people.
    expect(operatorEvent("organization/admin_organization_suspended").metadata).toMatchObject({
      members: "sole",
      reached: 2,
      skipped: 1,
    });
  });

  test("an account already suspended keeps its own suspension, and is reported as skipped, and why", async () => {
    await env.DB.prepare("update pithy_auth_users set suspended_at = ? where id = ?")
      .bind(NOW.getTime() - DAY, CAI)
      .run();
    const body = await bound(
      await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON, members: "sole" } }),
      AdminOrganizationSuspendResponse,
    );
    expect(body.members.skipped).toEqual([
      { userId: ADA, reason: "member_elsewhere" },
      { userId: CAI, reason: "already_suspended" },
    ]);
    expect((await account(CAI)).suspended_at).toBe(NOW.getTime() - DAY);
  });

  test("a second suspension restates the reason and the end, keeping the start, and fires no hook", async () => {
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    const until = new Date(NOW.getTime() + DAY).toISOString();
    const again = await bound(
      await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: "Still unpaid.", until } }),
      AdminOrganizationSuspendResponse,
    );
    expect(again).toMatchObject({
      changed: false,
      updated: true,
      suspendedAt: NOW.toISOString(),
      suspendedUntil: until,
    });
    expect(hooked.map((hook) => hook.name)).toEqual(["suspended"]);
    const { results } = await env.DB.prepare(
      "select action, reason from pithy_organization_lifecycle where organization_id = ? order by id",
    )
      .bind(ACME)
      .all();
    expect(results).toEqual([
      { action: "suspended", reason: REASON },
      { action: "suspended", reason: "Still unpaid." },
    ]);
  });

  test("suspendedUntil ends the suspension by itself, with no write", async () => {
    const until = new Date(NOW.getTime() + HOUR).toISOString();
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON, until } });
    expect(await listed(CAI)).toEqual([]);
    const later = buildApp({ now: new Date(NOW.getTime() + 2 * HOUR) });
    expect(await listed(CAI, later)).toEqual([ACME]);
    expect((await choose(CAI, ACME, later)).status).toBe(200);
    // Nothing cleared the columns: the end is read, never written.
    const row = await db().selectFrom(ORGANIZATIONS_TABLE).selectAll().where("id", "=", ACME).executeTakeFirstOrThrow();
    expect(row.suspendedAt).toBe(NOW.getTime());
  });

  test("an end in the past is refused", async () => {
    const response = await call("POST", `${ADMIN}/${ACME}/suspend`, {
      body: { reason: REASON, until: new Date(NOW.getTime() - HOUR).toISOString() },
    });
    expect(response.status).toBe(400);
  });

  test("the owner is told, with the reason, and the notice switches off on its own", async () => {
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    expect(mailed).toEqual([
      {
        to: "ada@example.com",
        template: "organizationSuspended",
        payload: { organizationName: "Acme Games", name: `Person ${ADA}`, reason: REASON },
      },
    ]);
    mailed = [];
    const quiet = buildApp({ config: { lifecycleEmails: { organizationSuspended: false } } });
    await call("POST", `${ADMIN}/${BETA}/suspend`, { body: { reason: REASON }, app: quiet });
    expect(mailed).toEqual([]);
  });

  test("the management listing says where each tenant stands", async () => {
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    const reader = buildApp({ scopes: [ORGANIZATION_ACCOUNTS_READ_SCOPE] });
    const body = await bound(await call("GET", ADMIN, { app: reader }), AdminOrganizationsResponse);
    const states = Object.fromEntries(body.organizations.map((organization) => [organization.id, organization.state]));
    expect(states).toEqual({ [ACME]: "suspended", [BETA]: "active" });
  });
});

describe("reinstating an organization", () => {
  test("clears the suspension, restores it to every member's list, and names the members whose own accounts stay suspended", async () => {
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON, members: "sole" } });
    mailed = [];
    const response = await call("POST", `${ADMIN}/${ACME}/reinstate`, { body: { reason: "Paid." } });
    const body = await bound(response, AdminOrganizationReinstateResponse);
    expect(body).toEqual({
      organizationId: ACME,
      changed: true,
      mailed: 1,
      membersStillShut: [
        { userId: BOB, state: "suspended" },
        { userId: CAI, state: "suspended" },
      ],
    });
    expect(await listed(ADA)).toEqual([ACME, BETA]);
    // Not silently: Bob's own account is still suspended, and nothing here reinstated it.
    expect((await account(BOB)).suspended_at).toBe(NOW.getTime());
    expect(mailed.map((mail) => mail.template)).toEqual(["organizationReinstated"]);
    expect(hooked.map((hook) => hook.name)).toEqual(["suspended", "reinstated"]);
  });

  test("an organization that is not suspended is a 200 that changed nothing", async () => {
    const body = await bound(
      await call("POST", `${ADMIN}/${ACME}/reinstate`, { body: { reason: REASON } }),
      AdminOrganizationReinstateResponse,
    );
    expect(body).toMatchObject({ changed: false, mailed: null, membersStillShut: [] });
  });

  test("a deleted organization is a conflict naming the restore route", async () => {
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } });
    const response = await call("POST", `${ADMIN}/${ACME}/reinstate`, { body: { reason: REASON } });
    expect(response.status).toBe(409);
    expect(refused?.payload.message).toContain(`POST ${ADMIN}/${ACME}/restore`);
  });
});

describe("deleting an organization", () => {
  test("with no mode, soft-deletes it with a window from retention.purgeAfterDays, and tells the owner the date", async () => {
    expect((await choose(CAI, ACME)).status).toBe(200);
    const body = await bound(
      await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } }),
      AdminOrganizationDeleteResponse,
    );
    expect(body).toEqual({
      organizationId: ACME,
      mode: "soft",
      outcome: "deleted",
      deletedAt: NOW.toISOString(),
      purgeAfter: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      purge: "scheduled",
      mailed: 1,
      members: { mode: "none", reached: [], skipped: [] },
    });
    expect(mailed.map((mail) => [mail.to, mail.template])).toEqual([
      ["ada@example.com", "organizationDeletionScheduled"],
    ]);
    // Gone from every member's list, and its selection with it. Its memberships are kept, for a restore.
    expect(await listed(ADA)).toEqual([BETA]);
    expect(await selection()).toBeUndefined();
    const memberships = await db()
      .selectFrom(MEMBERSHIPS_TABLE)
      .select("id")
      .where("organizationId", "=", ACME)
      .execute();
    expect(memberships).toHaveLength(3);
    // A member naming it is told it does not exist, as a stranger is.
    const named = await call("GET", `${BASE}/marks/organization/${ACME}`, { as: CAI });
    expect(named.status).toBe(404);
    expect(operatorEvent("organization/admin_organization_deleted").severity).toBe("warning");
  });

  test("the window is the configured one", async () => {
    const short = buildApp({ config: { retention: { purgeAfterDays: 7 } } });
    const body = await bound(
      await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON }, app: short }),
      AdminOrganizationDeleteResponse,
    );
    expect(body.purgeAfter).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
  });

  test("mode: hard closes the window now and starts the purge, and sends no deletion notice", async () => {
    const created: { id?: string; params?: unknown }[] = [];
    const binding = {
      create: async (instance?: { id?: string; params?: unknown }) => void created.push(instance ?? {}),
      get: async () => ({}),
    };
    const response = await call("DELETE", `${ADMIN}/${ACME}`, {
      body: { reason: REASON, mode: "hard" },
      env: { [ORGANIZATION_PURGE_BINDING]: binding },
    });
    const body = await bound(response, AdminOrganizationDeleteResponse);
    expect(body).toMatchObject({
      mode: "hard",
      outcome: "deleted",
      purgeAfter: NOW.toISOString(),
      purge: "started",
      mailed: null,
    });
    expect(created.map((instance) => instance.params)).toEqual([{ organizationId: ACME }]);
    expect(mailed).toEqual([]);
    expect(operatorEvent("organization/admin_organization_hard_deleted")).toBeDefined();
  });

  test("a hard deletion with no purge Workflow bound is pending, and the daily pass starts it", async () => {
    const body = await bound(
      await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON, mode: "hard" } }),
      AdminOrganizationDeleteResponse,
    );
    expect(body.purge).toBe("pending");
  });

  test("members: sole deletes only the sole members' accounts, softly, through the user lifecycle", async () => {
    const body = await bound(
      await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON, members: "sole" } }),
      AdminOrganizationDeleteResponse,
    );
    expect(body.members).toEqual({
      mode: "sole",
      reached: [
        { userId: BOB, outcome: "deleted" },
        { userId: CAI, outcome: "deleted" },
      ],
      skipped: [{ userId: ADA, reason: "member_elsewhere" }],
    });
    expect((await account(BOB)).deleted_at).toBe(NOW.getTime());
    expect(await account(ADA)).toEqual({ suspended_at: null, deleted_at: null });
  });

  test("a second soft deletion is unchanged, and a hard one brings its purge forward", async () => {
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } });
    const again = await bound(
      await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } }),
      AdminOrganizationDeleteResponse,
    );
    expect(again.outcome).toBe("unchanged");
    const hard = await bound(
      await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON, mode: "hard" } }),
      AdminOrganizationDeleteResponse,
    );
    expect(hard).toMatchObject({
      outcome: "brought_forward",
      deletedAt: NOW.toISOString(),
      purgeAfter: NOW.toISOString(),
    });
  });
});

describe("restoring an organization", () => {
  test("inside the window brings back the organization and its memberships, and names who is still shut out", async () => {
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON, members: "sole" } });
    const later = buildApp({ now: new Date(NOW.getTime() + DAY) });
    const body = await bound(
      await call("POST", `${ADMIN}/${ACME}/restore`, { body: { reason: "Deleted by mistake." }, app: later }),
      AdminOrganizationRestoreResponse,
    );
    expect(body).toEqual({
      organizationId: ACME,
      changed: true,
      state: "active",
      membersStillShut: [
        { userId: BOB, state: "deleted" },
        { userId: CAI, state: "deleted" },
      ],
    });
    expect(await listed(ADA, later)).toEqual([ACME, BETA]);
    expect((await choose(ADA, ACME, later)).status).toBe(200);
  });

  test("fires onOrganizationRestored once, as the operator, and a second restore fires nothing", async () => {
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } });
    expect((await call("POST", `${ADMIN}/${ACME}/restore`, { body: { reason: "Deleted by mistake." } })).status).toBe(
      200,
    );
    expect((await call("POST", `${ADMIN}/${ACME}/restore`, { body: { reason: REASON } })).status).toBe(200);
    expect(hooked.map((hook) => hook.name)).toEqual(["deleted", "restored"]);
    expect(hooked[1]?.event).toMatchObject({
      organizationId: ACME,
      actor: { type: "control-plane" },
      reason: "Deleted by mistake.",
      at: NOW,
    });
  });

  test("a suspension it was under is still in force after", async () => {
    await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } });
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } });
    const body = await bound(
      await call("POST", `${ADMIN}/${ACME}/restore`, { body: { reason: REASON } }),
      AdminOrganizationRestoreResponse,
    );
    expect(body.state).toBe("suspended");
    expect(await listed(ADA)).toEqual([BETA]);
  });

  test("after the window closes it is a conflict, and after the purge it answers 404", async () => {
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } });
    const closed = buildApp({ now: new Date(NOW.getTime() + 31 * DAY) });
    expect((await call("POST", `${ADMIN}/${ACME}/restore`, { body: { reason: REASON }, app: closed })).status).toBe(
      409,
    );
    expect(hooked.map((hook) => hook.name)).toEqual(["deleted"]);

    // What the purge leaves behind: no organization, and its own record that it erased one.
    await env.DB.prepare("delete from pithy_organization_memberships where organization_id = ?").bind(ACME).run();
    await env.DB.prepare("delete from pithy_organization_organizations where id = ?").bind(ACME).run();
    await db()
      .insertInto(LIFECYCLE_TABLE)
      .values({
        organizationId: ACME,
        action: "purged",
        actorType: "system",
        actorId: null,
        reason: null,
        suspendedUntil: null,
        step: null,
        createdAt: NOW.getTime() + 31 * DAY,
      })
      .execute();
    const gone = await call("POST", `${ADMIN}/${ACME}/restore`, { body: { reason: REASON }, app: closed });
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe("organization/not_found");
    expect(refused?.payload.action).toContain("was purged on");
  });
});

describe("the member cascade's wiring from the composed auth", () => {
  test("a composed Worker hands the cascade auth's own lifecycle config and the adopter's user hooks", async () => {
    // Auth as organization recognizes it: its resolved config, and the hooks the adopter passed to `auth()`.
    // `accountSuspended` is off here, so a mail that went out anyway would be a config that never arrived.
    const reachedByHook: string[] = [];
    const authShaped = {
      name: "auth",
      requiredBindings: [],
      authConfig: { ...USERS.config, lifecycleEmails: { ...USERS.config.lifecycleEmails, accountSuspended: false } },
      lifecycleHooks: { onUserSuspended: (event: { userId: string }) => void reachedByHook.push(event.userId) },
    } as unknown as Capability;
    const emailShaped = {
      name: "email",
      requiredBindings: [],
      emailConfig: {},
      enqueue: async (_env: unknown, input: Parameters<EnqueueInvitation>[0]) => enqueue(input),
    } as unknown as Capability;
    const composed = organization({ roles: catalog, baseUrl: "https://app.example.test", ownership: OWNERSHIP });
    composed.compose?.({ capabilities: [authShaped, emailShaped, composed] });

    const wired = buildApp({ routes: await mountOf(composed) });
    const response = await call("POST", `${ADMIN}/${ACME}/suspend`, {
      body: { reason: REASON, members: "sole" },
      app: wired,
    });
    expect(response.status).toBe(200);
    expect((await bound(response, AdminOrganizationSuspendResponse)).members.reached).toEqual([
      { userId: BOB, outcome: "suspended" },
      { userId: CAI, outcome: "suspended" },
    ]);
    expect((await account(BOB)).suspended_at).not.toBeNull();
    expect(reachedByHook).toEqual([BOB, CAI]);
    expect(mailed.filter((mail) => mail.template === "accountSuspended")).toEqual([]);
  });

  test("the organization's hook and each member's user hook are handed this request's env and waitUntil", async () => {
    const heard: { hook: string; env: unknown; waitUntil: unknown }[] = [];
    const authShaped = {
      name: "auth",
      requiredBindings: [],
      authConfig: USERS.config,
      lifecycleHooks: {
        onUserSuspended: (_event: unknown, _d1: unknown, runtime: { env: unknown; waitUntil?: unknown }) =>
          void heard.push({ hook: "onUserSuspended", env: runtime.env, waitUntil: runtime.waitUntil }),
      },
    } as unknown as Capability;
    const composed = organization.withEnv<{ DB: unknown; MARKER: string }>()({
      roles: catalog,
      baseUrl: "https://app.example.test",
      ownership: OWNERSHIP,
      onOrganizationSuspended: (_event, _d1, runtime) =>
        void heard.push({ hook: "onOrganizationSuspended", env: runtime.env, waitUntil: runtime.waitUntil }),
    });
    const emailShaped = {
      name: "email",
      requiredBindings: [],
      emailConfig: {},
      enqueue: async (_env: unknown, input: Parameters<EnqueueInvitation>[0]) => enqueue(input),
    } as unknown as Capability;
    composed.compose?.({ capabilities: [authShaped, emailShaped, composed] });
    const kept: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => void kept.push(promise),
      passThroughOnException: () => {},
      props: {},
    };

    const response = await call("POST", `${ADMIN}/${ACME}/suspend`, {
      body: { reason: REASON, members: "sole" },
      app: buildApp({ routes: await mountOf(composed) }),
      env: { MARKER: "this request" },
      executionCtx,
    });
    expect(response.status).toBe(200);
    expect(heard.map((each) => each.hook)).toEqual(["onOrganizationSuspended", "onUserSuspended", "onUserSuspended"]);
    for (const each of heard) {
      expect(each.env).toMatchObject({ DB: env.DB, MARKER: "this request" });
      expect(each.waitUntil).toBeTypeOf("function");
    }
  });

  test("with no auth wired, a cascade is refused before the organization moves: no transition, no event, no mail", async () => {
    const unwired = buildApp({ userLifecycle: null });
    const suspended = await call("POST", `${ADMIN}/${ACME}/suspend`, {
      body: { reason: REASON, members: "sole" },
      app: unwired,
    });
    expect(suspended.status).toBe(500);
    const deleted = await call("DELETE", `${ADMIN}/${ACME}`, {
      body: { reason: REASON, members: "sole" },
      app: unwired,
    });
    expect(deleted.status).toBe(500);

    const row = await db().selectFrom(ORGANIZATIONS_TABLE).selectAll().where("id", "=", ACME).executeTakeFirstOrThrow();
    expect([row.suspendedAt, row.deletedAt]).toEqual([null, null]);
    expect(await db().selectFrom(LIFECYCLE_TABLE).selectAll().execute()).toEqual([]);
    // The gate records the call it let through; nothing past it wrote to the trail.
    expect(events.filter((event) => !event.action.startsWith("controlplane/"))).toEqual([]);
    expect(mailed).toEqual([]);
    expect(hooked).toEqual([]);
  });
});

describe("previewing a member cascade", () => {
  const SUSPEND_PREVIEW = `${ADMIN}/${ACME}/suspend/preview`;
  const DELETE_PREVIEW = `${ADMIN}/${ACME}/delete/preview`;

  /** Each preview, beside the write it previews and the scope both demand. */
  const PAIRS = [
    {
      preview: { method: "POST", path: SUSPEND_PREVIEW },
      write: { method: "POST", path: `${ADMIN}/${ACME}/suspend` },
      scope: ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
    },
    {
      preview: { method: "POST", path: DELETE_PREVIEW },
      write: { method: "DELETE", path: `${ADMIN}/${ACME}` },
      scope: ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
    },
  ] as const;

  /** Everything a write would leave behind: auth's columns and history, the tenant's, the selections, the memberships. */
  async function state(): Promise<unknown> {
    const tables = [
      "select id, suspended_at, suspended_until, deleted_at, purge_after from pithy_auth_users order by id",
      "select * from pithy_auth_user_lifecycle order by id",
      "select * from pithy_organization_organizations order by id",
      "select * from pithy_organization_lifecycle order by id",
      "select * from pithy_organization_acting order by session_id",
      "select id, organization_id, user_id, role from pithy_organization_memberships order by id",
    ];
    return Promise.all(tables.map(async (query) => (await env.DB.prepare(query).all()).results));
  }

  /** Status, code and message of a refusal, which is what a client acts on. */
  async function refusal(response: Response): Promise<{ status: number; code: string; message: string }> {
    const error = (await response.json()) as { error: { code: string; message: string } };
    return { status: response.status, code: error.error.code, message: error.error.message };
  }

  test("each preview demands the write's own scope; every other is 403", async () => {
    for (const pair of PAIRS) {
      const others = buildApp({
        scopes: [
          ORGANIZATION_ACCOUNTS_READ_SCOPE,
          ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
          ORGANIZATION_MEMBERS_WRITE_SCOPE,
          ...LIFECYCLE_SCOPES.filter((scope) => scope !== pair.scope),
        ],
      });
      const refused = await call(pair.preview.method, pair.preview.path, {
        app: others,
        body: { reason: REASON, members: "sole" },
      });
      expect(refused.status, pair.preview.path).toBe(403);
      const allowed = await call(pair.preview.method, pair.preview.path, {
        app: buildApp({ scopes: [pair.scope] }),
        body: { reason: REASON, members: "sole" },
      });
      expect(allowed.status, pair.preview.path).toBe(200);
    }
  });

  test("each refuses whatever its write refuses, with the same error", async () => {
    const past = new Date(NOW.getTime() - HOUR).toISOString();
    const cases: { name: string; body: unknown; pairs: readonly (typeof PAIRS)[number][]; app?: Hono<PithyHonoEnv> }[] =
      [
        { name: "no reason", body: {}, pairs: PAIRS },
        { name: "an empty reason", body: { reason: "" }, pairs: PAIRS },
        { name: "a reason carrying an address", body: { reason: "asked by ada@example.com" }, pairs: PAIRS },
        { name: "an unknown field", body: { reason: REASON, nonsense: true }, pairs: PAIRS },
        { name: "a cascade that is not one", body: { reason: REASON, members: "all" }, pairs: PAIRS },
        { name: "an end that is not a date", body: { reason: REASON, until: "tomorrow" }, pairs: [PAIRS[0]] },
        { name: "an end in the past", body: { reason: REASON, until: past }, pairs: [PAIRS[0]] },
        { name: "an end on a deletion", body: { reason: REASON, until: past }, pairs: [PAIRS[1]] },
        { name: "a deletion mode that is not one", body: { reason: REASON, mode: "purge" }, pairs: [PAIRS[1]] },
        {
          name: "a cascade on a Worker with no auth",
          body: { reason: REASON, members: "sole" },
          pairs: PAIRS,
          app: buildApp({ userLifecycle: null }),
        },
      ];
    for (const { name, body, pairs, app: using } of cases) {
      for (const pair of pairs) {
        const before = await state();
        const write = await refusal(await call(pair.write.method, pair.write.path, { body, app: using }));
        const preview = await refusal(await call(pair.preview.method, pair.preview.path, { body, app: using }));
        expect(write.status, `${name}: ${pair.write.path}`).toBeGreaterThanOrEqual(400);
        expect(preview, `${name}: ${pair.preview.path}`).toEqual(write);
        expect(await state(), name).toEqual(before);
      }
    }
  });

  test("an unknown organization is the write's 404", async () => {
    for (const pair of PAIRS) {
      const write = await refusal(
        await call(pair.write.method, pair.write.path.replace(ACME, ABSENT), { body: { reason: REASON } }),
      );
      const preview = await refusal(
        await call(pair.preview.method, pair.preview.path.replace(ACME, ABSENT), { body: { reason: REASON } }),
      );
      expect(write).toMatchObject({ status: 404, code: "organization/not_found" });
      expect(preview).toEqual(write);
    }
  });

  test("a deleted organization's suspension preview is the write's conflict, naming the restore route", async () => {
    await call("DELETE", `${ADMIN}/${ACME}`, { body: { reason: REASON } });
    const write = await refusal(await call("POST", `${ADMIN}/${ACME}/suspend`, { body: { reason: REASON } }));
    const preview = await refusal(await call("POST", SUSPEND_PREVIEW, { body: { reason: REASON, members: "sole" } }));
    expect(write).toMatchObject({ status: 409, message: expect.stringContaining(`POST ${ADMIN}/${ACME}/restore`) });
    expect(preview).toEqual(write);
  });

  test("with members absent or none, a preview answers an empty cascade", async () => {
    for (const pair of PAIRS) {
      for (const body of [{ reason: REASON }, { reason: REASON, members: "none" }]) {
        const response = await call(pair.preview.method, pair.preview.path, { body });
        expect(response.status).toBe(200);
        expect(await bound(response, AdminMemberCascadePreviewResponse)).toEqual({
          organizationId: ACME,
          members: { mode: "none", reached: [], skipped: [] },
        });
      }
    }
  });

  test("a suspension's preview is the cascade the suspension then produces", async () => {
    // Cai is already suspended on his own, so the preview must say he is skipped, and why.
    await env.DB.prepare("update pithy_auth_users set suspended_at = ? where id = ?")
      .bind(NOW.getTime() - DAY, CAI)
      .run();
    const body = { reason: REASON, members: "sole" };
    const preview = await bound(await call("POST", SUSPEND_PREVIEW, { body }), AdminMemberCascadePreviewResponse);
    expect(preview.members).toEqual({
      mode: "sole",
      reached: [{ userId: BOB, outcome: "suspended" }],
      skipped: [
        { userId: ADA, reason: "member_elsewhere" },
        { userId: CAI, reason: "already_suspended" },
      ],
    });
    const written = await bound(
      await call("POST", `${ADMIN}/${ACME}/suspend`, { body }),
      AdminOrganizationSuspendResponse,
    );
    expect(written.members).toEqual(preview.members);
  });

  test("a deletion's preview is the cascade the deletion then produces, soft and hard", async () => {
    await env.DB.prepare("update pithy_auth_users set deleted_at = ?, purge_after = ? where id = ?")
      .bind(NOW.getTime() - DAY, NOW.getTime() + DAY, CAI)
      .run();
    for (const mode of ["soft", "hard"] as const) {
      const body = { reason: REASON, members: "sole", mode };
      const preview = await bound(await call("POST", DELETE_PREVIEW, { body }), AdminMemberCascadePreviewResponse);
      expect(
        preview.members.reached.map((member) => member.userId),
        mode,
      ).toEqual(mode === "soft" ? [BOB] : [BOB, CAI]);
      if (mode === "hard") {
        const written = await bound(
          await call("DELETE", `${ADMIN}/${ACME}`, { body }),
          AdminOrganizationDeleteResponse,
        );
        expect(written.members).toEqual(preview.members);
      }
    }
  });

  test("a soft deletion's preview is the soft deletion's cascade", async () => {
    const body = { reason: REASON, members: "sole" };
    const preview = await bound(await call("POST", DELETE_PREVIEW, { body }), AdminMemberCascadePreviewResponse);
    const written = await bound(await call("DELETE", `${ADMIN}/${ACME}`, { body }), AdminOrganizationDeleteResponse);
    expect(written.members).toEqual(preview.members);
    expect(preview.members.reached).toEqual([
      { userId: BOB, outcome: "deleted" },
      { userId: CAI, outcome: "deleted" },
    ]);
  });

  test("a preview writes nothing: no column, no history row, no mail, no hook, no audit event", async () => {
    const before = await state();
    expect((await choose(CAI, ACME)).status).toBe(200);
    const selected = await state();
    events = [];
    for (const body of [
      { reason: REASON, members: "sole" },
      { reason: REASON, members: "sole", until: new Date(NOW.getTime() + DAY).toISOString() },
    ]) {
      expect((await call("POST", SUSPEND_PREVIEW, { body })).status).toBe(200);
    }
    const created: unknown[] = [];
    const binding = { create: async (instance?: unknown) => void created.push(instance), get: async () => ({}) };
    for (const mode of ["soft", "hard"] as const) {
      const response = await call("POST", DELETE_PREVIEW, {
        body: { reason: REASON, members: "sole", mode },
        env: { [ORGANIZATION_PURGE_BINDING]: binding },
      });
      expect(response.status).toBe(200);
    }
    expect(await state()).toEqual(selected);
    expect(created).toEqual([]);
    expect(before).not.toEqual(selected);
    expect(mailed).toEqual([]);
    expect(hooked).toEqual([]);
    // The gate records the call it let through, as it does for every control-plane call; nothing past it wrote.
    expect(events.filter((event) => !event.action.startsWith("controlplane/"))).toEqual([]);
  });
});

describe("an owner's DELETE /current", () => {
  /** A Workflow's journal and retry loop, in miniature: enough to run the purge the route starts. */
  function workflowStep(): WorkflowStepLike {
    const journal = new Map<string, unknown>();
    return {
      async do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
        const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => Promise<T>;
        if (journal.has(name)) return journal.get(name) as T;
        const value = await fn();
        journal.set(name, value);
        return value;
      },
    } as WorkflowStepLike;
  }

  /** The history rows one organization's deletion wrote. */
  async function deletions(organizationId: string) {
    return db()
      .selectFrom(LIFECYCLE_TABLE)
      .select(["action", "actorType", "actorId", "reason", "mode"])
      .where("organizationId", "=", organizationId)
      .where("action", "=", "deleted")
      .execute();
  }

  test("shuts the organization through the lifecycle: refused to every member, gone from every list, recorded with the owner", async () => {
    await choose(ADA, ACME);
    const response = await call("DELETE", `${BASE}/current`, { as: ADA });
    expect(response.status).toBe(200);
    expect(await bound(response, DeletedOrganizationResponse)).toEqual({
      organizationId: ACME,
      deletedAt: NOW.toISOString(),
      purge: "pending",
    });
    // A request with no body records the fixed reason, hard, with the owner as the actor.
    expect(await deletions(ACME)).toEqual([
      { action: "deleted", actorType: "owner", actorId: ADA, reason: OWNER_DELETE_REASON, mode: "hard" },
    ]);
    for (const member of [ADA, BOB, CAI]) expect(await listed(member)).not.toContain(ACME);
    expect((await choose(BOB, ACME)).status).toBe(404);
    expect(await selection()).toBeUndefined();
    // Ada carries on in Beta.
    expect(await listed(ADA)).toContain(BETA);
    expect(hooked).toEqual([
      {
        name: "deleted",
        event: {
          organizationId: ACME,
          actor: { type: "owner", id: ADA },
          reason: OWNER_DELETE_REASON,
          at: NOW,
          purgeAfter: NOW,
        },
      },
    ]);
    const event = events.find((each) => each.action === "organization/deleted");
    expect(event).toMatchObject({ actorType: "user", actorId: ADA, tenant: ACME });
    expect(event?.metadata).toMatchObject({ mode: "hard", purge: "pending", members: "none" });
    expect(event?.metadata).not.toHaveProperty("reason");
    // Nothing is erased by the request: the memberships wait for the purge.
    const kept = await db().selectFrom(MEMBERSHIPS_TABLE).select("id").where("organizationId", "=", ACME).execute();
    expect(kept).toHaveLength(3);
  });

  test("takes a reason held to the operator's rules, and refuses a bad one before anything moves", async () => {
    await choose(ADA, ACME);
    for (const reason of ["", "x".repeat(501), "Mail ada@example.com instead."]) {
      const refusal = await call("DELETE", `${BASE}/current`, { as: ADA, body: { reason } });
      expect(refusal.status, JSON.stringify(reason).slice(0, 40)).toBe(400);
    }
    expect((await call("DELETE", `${BASE}/current`, { as: ADA, body: { reason: REASON, mode: "soft" } })).status).toBe(
      400,
    );
    expect(await deletions(ACME)).toEqual([]);
    const response = await call("DELETE", `${BASE}/current`, { as: ADA, body: { reason: `  ${REASON}  ` } });
    expect(response.status).toBe(200);
    expect(await deletions(ACME)).toEqual([
      { action: "deleted", actorType: "owner", actorId: ADA, reason: REASON, mode: "hard" },
    ]);
    expect(events.find((each) => each.action === "organization/deleted")?.metadata).toMatchObject({ reason: REASON });
  });

  test("an empty body under a JSON content type is a request with no body", async () => {
    await choose(ADA, ACME);
    const response = await call("DELETE", `${BASE}/current`, { as: ADA, rawBody: "" });
    expect(response.status).toBe(200);
    expect(await deletions(ACME)).toEqual([
      { action: "deleted", actorType: "owner", actorId: ADA, reason: OWNER_DELETE_REASON, mode: "hard" },
    ]);
  });

  test("a purge Workflow whose start throws leaves the deletion standing and answers pending", async () => {
    await choose(ADA, ACME);
    const binding = {
      create: async () => {
        throw new Error("the Workflow service is unavailable");
      },
      get: async () => {
        throw new Error("no such instance");
      },
    };
    const response = await call("DELETE", `${BASE}/current`, {
      as: ADA,
      env: { [ORGANIZATION_PURGE_BINDING]: binding },
    });
    expect(response.status).toBe(200);
    expect((await bound(response, DeletedOrganizationResponse)).purge).toBe("pending");
    expect(await deletions(ACME)).toHaveLength(1);
    expect(await listed(BOB)).not.toContain(ACME);
    expect(events.find((each) => each.action === "organization/deleted")?.metadata).toMatchObject({
      purge: "pending",
    });
  });

  test("starts the purge Workflow when it is bound, under the deletion's own instance", async () => {
    await choose(ADA, ACME);
    const created: { id?: string; params?: unknown }[] = [];
    const binding = {
      create: async (instance?: { id?: string; params?: unknown }) => void created.push(instance ?? {}),
      get: async () => ({}),
    };
    const response = await call("DELETE", `${BASE}/current`, {
      as: ADA,
      env: { [ORGANIZATION_PURGE_BINDING]: binding },
    });
    expect((await bound(response, DeletedOrganizationResponse)).purge).toBe("started");
    expect(created.map((instance) => instance.params)).toEqual([{ organizationId: ACME }]);
  });

  test("takes a member who is not an owner nowhere", async () => {
    await choose(BOB, ACME);
    expect((await call("DELETE", `${BASE}/current`, { as: BOB })).status).toBe(403);
    expect(await deletions(ACME)).toEqual([]);
    expect(hooked).toEqual([]);
  });

  test("the purge it leaves runs every composed contribution with the deletion, organization's last, then fires onOrganizationPurged and leaves the attestation's record", async () => {
    await choose(ADA, ACME);
    expect((await call("DELETE", `${BASE}/current`, { as: ADA, body: { reason: REASON } })).status).toBe(200);
    await env.DB.prepare("drop table if exists adopter_projects").run();
    await env.DB.prepare("create table adopter_projects (id text primary key, organization_id text not null)").run();
    await env.DB.prepare("insert into adopter_projects (id, organization_id) values ('p-acme', ?), ('p-beta', ?)")
      .bind(ACME, BETA)
      .run();

    const order: string[] = [];
    const handed: (PurgeDeletion | undefined)[] = [];
    const files: PurgeStep = {
      step: "files",
      contribution: {
        subject: "organization",
        summary: "Deletes the organization's stored files.",
        erase: async (context) => {
          order.push("files");
          handed.push(context.deletion);
        },
      },
    };
    const own: PurgeStep = {
      step: "organization",
      contribution: organizationPurgeContribution("DB", (d1, organizationId) => {
        order.push("organization");
        return [
          (createDatabase(d1, {}) as unknown as Kysely<Record<string, Record<string, unknown>>>)
            .deleteFrom("adopterProjects")
            .where("organizationId", "=", organizationId),
        ];
      }),
    };
    const purged: OrganizationLifecycleHookEvent[] = [];
    const deps = {
      db: db(),
      d1: env.DB,
      hooks: { onOrganizationPurged: (event: OrganizationLifecycleHookEvent) => void purged.push(event) },
      runtime: { env: { DB: env.DB } },
      now: () => NOW,
    };
    const outcome = await purgeOrganization(
      { steps: [own, files], env: { DB: env.DB }, ops: organizationPurgeOps(deps), held: async () => false },
      workflowStep(),
      Error as never,
      { organizationId: ACME },
    );
    expect(outcome).toMatchObject({ state: "purged", erased: ["files", "organization"] });
    expect(order).toEqual(["files", "organization"]);
    expect(handed).toEqual([{ actor: { type: "owner", id: ADA }, reason: REASON, mode: "hard", at: NOW }]);
    // The app's onDelete rows went in organization's own step; Beta's are untouched.
    const { results } = await env.DB.prepare("select id from adopter_projects").all();
    expect(results).toEqual([{ id: "p-beta" }]);
    expect(await db().selectFrom(ORGANIZATIONS_TABLE).select("id").where("id", "=", ACME).execute()).toEqual([]);
    expect(purged.map((event) => event.organizationId)).toEqual([ACME]);
    const record = await organizationErasureReader(db()).history([ACME]);
    expect(record.map((row) => [row.action, row.actorType, row.mode])).toEqual([
      ["deleted", "owner", "hard"],
      ["purge_step", "system", null],
      ["purge_step", "system", null],
      ["purged", "system", null],
    ]);
  });
});

describe("ownerDelete.members", () => {
  const SOLE = { config: { ownerDelete: { members: "sole" as const } } };

  test("`sole` deletes, hard, the accounts of the members whose only organization this is, and never the owner's", async () => {
    await choose(DEE, BETA);
    // Beta holds Dee (owner, Beta only) and Ada (also in Acme). Dee is sole and is the actor; Ada belongs elsewhere.
    const response = await call("DELETE", `${BASE}/current`, { as: DEE, app: buildApp(SOLE) });
    expect(response.status).toBe(200);
    expect((await bound(response, DeletedOrganizationResponse)).members).toEqual({
      mode: "sole",
      reached: [],
      skipped: [
        { userId: ADA, reason: "member_elsewhere" },
        { userId: DEE, reason: "actor" },
      ],
    });
    expect((await account(DEE)).deleted_at).toBeNull();
    expect((await account(ADA)).deleted_at).toBeNull();
  });

  test("`sole` reaches the sole members through auth's own lifecycle, with the owner as the actor", async () => {
    await choose(ADA, ACME);
    const response = await call("DELETE", `${BASE}/current`, {
      as: ADA,
      app: buildApp(SOLE),
      body: { reason: REASON },
    });
    expect((await bound(response, DeletedOrganizationResponse)).members).toEqual({
      mode: "sole",
      reached: [
        { userId: BOB, outcome: "deleted" },
        { userId: CAI, outcome: "deleted" },
      ],
      skipped: [{ userId: ADA, reason: "member_elsewhere" }],
    });
    expect((await account(BOB)).deleted_at).not.toBeNull();
    expect((await account(ADA)).deleted_at).toBeNull();
    const history = await env.DB.prepare(
      "select actor_type, actor_id, reason from pithy_auth_user_lifecycle where user_id = ? and action = 'deleted'",
    )
      .bind(BOB)
      .all();
    expect(history.results).toEqual([{ actor_type: "user", actor_id: ADA, reason: REASON }]);
  });

  test("the default, `none`, deletes nobody's account and names no cascade", async () => {
    await choose(ADA, ACME);
    const response = await call("DELETE", `${BASE}/current`, { as: ADA });
    expect(await bound(response, DeletedOrganizationResponse)).not.toHaveProperty("members");
    for (const member of [BOB, CAI]) expect((await account(member)).deleted_at).toBeNull();
  });

  test("`sole` with no auth composed is refused before the organization moves", async () => {
    await choose(ADA, ACME);
    const response = await call("DELETE", `${BASE}/current`, {
      as: ADA,
      app: buildApp({ ...SOLE, userLifecycle: null }),
    });
    expect(response.status).toBe(500);
    expect(await listed(BOB)).toContain(ACME);
  });
});

describe("deleteOrganizationAsOwner", () => {
  afterEach(() => forgetComposition());

  test("an app route that checks a typed name first runs the same deletion through the composed capability", async () => {
    const composed = organization({
      roles: catalog,
      baseUrl: "https://app.example.test",
      ownership: OWNERSHIP,
      sendInvitationEmail: false,
    });
    composed.compose?.({ capabilities: [composed] });
    recordComposition([composed]);
    const guard = {
      catalog,
      database: (bindings: Record<string, unknown>) => organizationDatabase(bindings.DB as D1Database),
      now: () => NOW,
    };
    const routes = (app: Hono<PithyHonoEnv>) => {
      const typed = app as unknown as Hono<OrganizationHonoEnv<Role>>;
      typed.post(
        "/settings/close",
        requireOrganization(guard),
        validate("json", z.object({ name: z.string().describe("The organization's name, typed.") })),
        async (c) => {
          if (c.req.valid("json").name !== c.var.acting.name) {
            throw new ValidationError({ message: "Type the organization's name to close it." });
          }
          const deleted = await deleteOrganizationAsOwner(c, { reason: "Closed from settings." });
          return c.json({ organizationId: deleted.organizationId, purge: deleted.purge });
        },
      );
    };
    const appWithRoute = buildApp({ routes });
    await choose(ADA, ACME);
    expect((await call("POST", "/settings/close", { as: ADA, app: appWithRoute, body: { name: "Acme" } })).status).toBe(
      400,
    );
    expect(await deletions()).toEqual([]);
    const closed = await call("POST", "/settings/close", { as: ADA, app: appWithRoute, body: { name: "Acme Games" } });
    expect(await closed.json()).toEqual({ organizationId: ACME, purge: "pending" });
    expect(await deletions()).toEqual([{ actorType: "owner", actorId: ADA, reason: "Closed from settings." }]);
    expect(await listed(BOB)).not.toContain(ACME);
  });

  test("holds an app route's reason to the operator's rules, refusing a bad one before anything is written", async () => {
    const composed = organization({
      roles: catalog,
      baseUrl: "https://app.example.test",
      ownership: OWNERSHIP,
      sendInvitationEmail: false,
    });
    composed.compose?.({ capabilities: [composed] });
    recordComposition([composed]);
    const guard = {
      catalog,
      database: (bindings: Record<string, unknown>) => organizationDatabase(bindings.DB as D1Database),
      now: () => NOW,
    };
    const routes = (app: Hono<PithyHonoEnv>) => {
      const typed = app as unknown as Hono<OrganizationHonoEnv<Role>>;
      typed.post(
        "/settings/close",
        requireOrganization(guard),
        validate("json", z.object({ reason: z.string().describe("Whatever the app passes on, unchecked.") })),
        async (c) => {
          const deleted = await deleteOrganizationAsOwner(c, { reason: c.req.valid("json").reason });
          return c.json({ purge: deleted.purge });
        },
      );
    };
    const appWithRoute = buildApp({ routes });
    await choose(ADA, ACME);
    for (const reason of ["", "x".repeat(501), "Mail ada@example.com instead."]) {
      const refusal = await call("POST", "/settings/close", { as: ADA, app: appWithRoute, body: { reason } });
      expect(refusal.status, JSON.stringify(reason).slice(0, 40)).toBe(400);
      expect((await errorOf(refusal)).code).toBe("validation/invalid_input");
    }
    expect(await deletions()).toEqual([]);
    expect(await listed(BOB)).toContain(ACME);
    expect(events.filter((each) => each.action === "organization/deleted")).toEqual([]);
  });

  test("refuses a caller whose role does not hold organization:delete, even behind the app's own gates", async () => {
    const composed = organization({
      roles: catalog,
      baseUrl: "https://app.example.test",
      ownership: OWNERSHIP,
      sendInvitationEmail: false,
    });
    composed.compose?.({ capabilities: [composed] });
    recordComposition([composed]);
    const guard = {
      catalog,
      database: (bindings: Record<string, unknown>) => organizationDatabase(bindings.DB as D1Database),
      now: () => NOW,
    };
    const routes = (app: Hono<PithyHonoEnv>) => {
      const typed = app as unknown as Hono<OrganizationHonoEnv<Role>>;
      typed.post("/settings/close", requireOrganization(guard), async (c) => {
        await deleteOrganizationAsOwner(c);
        return c.json({});
      });
    };
    await choose(BOB, ACME);
    expect((await call("POST", "/settings/close", { as: BOB, app: buildApp({ routes }) })).status).toBe(403);
    expect(await deletions()).toEqual([]);
  });

  test("refuses an app route that never mounted requireOrganization(), even for the owner, before anything is written", async () => {
    const composed = organization({
      roles: catalog,
      baseUrl: "https://app.example.test",
      ownership: OWNERSHIP,
      sendInvitationEmail: false,
    });
    composed.compose?.({ capabilities: [composed] });
    recordComposition([composed]);
    const routes = (app: Hono<PithyHonoEnv>) => {
      const typed = app as unknown as Hono<OrganizationHonoEnv<Role>>;
      typed.post("/settings/close", async (c) => {
        await deleteOrganizationAsOwner(c, { reason: "Closed from settings." });
        return c.json({});
      });
    };
    await choose(ADA, ACME);
    const refusal = await call("POST", "/settings/close", { as: ADA, app: buildApp({ routes }) });
    expect(refusal.status).toBe(403);
    expect((await errorOf(refusal)).code).toBe("organization/forbidden");
    expect(await deletions()).toEqual([]);
    expect(await listed(BOB)).toContain(ACME);
    expect(events.filter((each) => each.action === "organization/deleted")).toEqual([]);
  });

  async function deletions() {
    return db()
      .selectFrom(LIFECYCLE_TABLE)
      .select(["actorType", "actorId", "reason"])
      .where("organizationId", "=", ACME)
      .where("action", "=", "deleted")
      .execute();
  }
});
