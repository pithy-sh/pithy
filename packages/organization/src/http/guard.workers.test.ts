// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { type ActingMembership, chooseActing } from "../acting/acting";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { requireMayAssign } from "../members/members";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "../migrations/0001_init";
import { defineRoles } from "../roles/roles";
import { type OrganizationGuardDeps, type OrganizationHonoEnv, requireOrganization, requirePower } from "./guard";

/**
 * The gates, over real D1 and through a real Hono app with the real error codec.
 *
 * **The 404 is the security property, and it is only a property once it has been rendered.** A caller
 * who can tell "no such organization" from "not one of yours" holds an existence oracle, and iterating
 * it produces the tenant list. That the two refusals are *constructed* the same is not the claim; the
 * claim is that the two bodies a client receives are equal, so the comparison is made on what
 * `pithyErrorHandler` actually wrote — with the second half asserting that the distinction an operator
 * needs survives in `detail`, which the codec strips.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ABSENT = "44444444-4444-4444-8444-444444444444";

const INSIDER = "user_11111111";
const STRANGER = "user_22222222";
const NEIGHBOR = "user_33333333";
const OWNER = "user_44444444";

const SESSION = "session_aaaa";
const NOW = new Date("2026-09-05T12:00:00.000Z");

const catalog = defineRoles({
  powers: ["connections:read", "connections:manage"],
  roles: {
    member: ["organization:read", "connections:read"],
    admin: ["organization:read", "connections:read", "connections:manage", "organization:manage"],
    owner: [
      "organization:read",
      "connections:read",
      "connections:manage",
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

const deps: OrganizationGuardDeps<"connections:read" | "connections:manage", Role> = {
  catalog,
  database: (bindings) => organizationDatabase(bindings.DB as D1Database),
};

/** The last fault the app refused with, so a test can read the `detail` the wire never carries. */
let refused: PithyError | null = null;

/**
 * The app under test, mounted the way an adopter mounts it: the session seam first, then the gates.
 *
 * The session is seeded from headers rather than from a real sign-in, because what is under test is the
 * gate's behavior given an identity — `@pithy-sh/auth` is what proves the identity, and proving it twice
 * here would test that package instead of this one.
 */
function buildApp(): Hono<OrganizationHonoEnv<Role>> {
  const app = new Hono<OrganizationHonoEnv<Role>>();
  app.onError((error, c) => {
    refused = error instanceof PithyError ? error : null;
    return pithyErrorHandler(error, c);
  });
  app.use("*", async (c, next) => {
    const userId = c.req.header("x-test-user");
    const sessionId = c.req.header("x-test-session");
    c.set("auth", userId && sessionId ? AuthContext.parse({ userId, sessionId, scopes: [], locale: null }) : null);
    await next();
  });

  // No gate at all. What a route that forgot the middleware sees.
  app.get("/ungated", (c) => c.json({ acting: c.get("acting") ?? null }));

  app.get("/gated", requireOrganization(deps), (c) => c.json(c.var.acting));

  // The route declares what it accepts and the gate reads it back — the kit's request contract, and the
  // reason the gate never reaches for a raw path parameter.
  app.get(
    "/named/:organizationId",
    zValidator("param", z.object({ organizationId: z.uuid() }), validationHook),
    requireOrganization(deps, { from: "param", name: "organizationId" }),
    (c) => c.json(c.var.acting),
  );

  // Optional in the schema, deliberately: the gate rather than the validator has to be what refuses an
  // absent name, because the property under test is that it does not quietly fall back to the session.
  app.get(
    "/named-query",
    zValidator("query", z.object({ organizationId: z.uuid().optional() }), validationHook),
    requireOrganization(deps, { from: "query", name: "organizationId" }),
    (c) => c.json(c.var.acting),
  );

  // Named, with no schema declared for the name. Nothing to read, so nothing is guessed.
  app.get(
    "/named-undeclared/:organizationId",
    requireOrganization(deps, { from: "param", name: "organizationId" }),
    (c) => c.json(c.var.acting),
  );

  app.get("/read", requireOrganization(deps), requirePower("connections:read", deps), (c) => c.json({ ok: true }));

  app.get("/manage", requireOrganization(deps), requirePower("members:manage", deps), (c) => c.json({ ok: true }));

  // Deliberately missing `requireOrganization()`. A gate whose answer depended on where it was mounted
  // would be worse than one that refuses.
  app.get("/power-only", requirePower("organization:read", deps), (c) => c.json({ ok: true }));

  app.get(
    "/assign",
    zValidator("query", z.object({ role: catalog.AssignableRole }), validationHook),
    requireOrganization(deps),
    (c) => {
      requireMayAssign(catalog, c.var.acting.role, c.req.valid("query").role);
      return c.json({ ok: true });
    },
  );

  return app;
}

let app: Hono<OrganizationHonoEnv<Role>>;

async function call(path: string, who?: { userId: string; sessionId?: string }): Promise<Response> {
  const headers: Record<string, string> = {};
  if (who) {
    headers["x-test-user"] = who.userId;
    headers["x-test-session"] = who.sessionId ?? SESSION;
  }
  return await app.request(path, { headers }, { DB: env.DB } as unknown as Record<string, unknown>);
}

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "organization",
      order: ORGANIZATION_MIGRATION_ORDER,
      migrations: { "0001_init": organization_0001_init },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => organizationDatabase(env.DB);

async function organization(id: string, name: string, slug: string): Promise<void> {
  await db()
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id, name, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
    .execute();
}

async function membership(organizationId: string, userId: string, role: Role): Promise<void> {
  await db()
    .insertInto(MEMBERSHIPS_TABLE)
    .values(Membership.encode({ id: crypto.randomUUID(), organizationId, userId, role, createdAt: NOW }))
    .execute();
}

beforeEach(async () => {
  for (const table of [
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
  await organization(ACME, "Acme Games", "acme");
  await organization(BETA, "Beta Studio", "beta");
  await membership(ACME, INSIDER, "admin");
  await membership(ACME, OWNER, "owner");
  await membership(BETA, NEIGHBOR, "owner");
  refused = null;
  app = buildApp();
});

describe("requireOrganization — what it proves before a handler runs", () => {
  test("it fails closed on its own, rather than trusting that requireAuth ran above it", async () => {
    const response = await call("/gated");
    expect(response.status).toBe(401);
  });

  test("a proved membership reaches the handler as `acting`", async () => {
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    const response = await call("/gated", { userId: INSIDER });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizationId: ACME,
      slug: "acme",
      name: "Acme Games",
      userId: INSIDER,
      role: "admin",
      chosen: true,
    });
  });

  test("a route without the gate cannot read `acting`", async () => {
    // The type says non-optional downstream of the middleware; this says the middleware is what makes it
    // so. A handler that merely sat in the same file would otherwise read whatever the last request set.
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    const response = await call("/ungated", { userId: INSIDER });
    expect(await response.json()).toEqual({ acting: null });
  });

  test("a caller who belongs nowhere is told so in wording that names no organization", async () => {
    const response = await call("/gated", { userId: STRANGER });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("No organization is in force.");
    expect(body.error.message).not.toBe("That organization does not exist.");
    expect(refused?.payload.detail).toBe(`user ${STRANGER} has no membership in any organization`);
  });

  test("a caller who belongs somewhere but has chosen nothing is pointed at the chooser, not at an invitation", async () => {
    const response = await call("/gated", { userId: INSIDER });
    expect(response.status).toBe(404);
    expect(refused?.payload.action).toBe("Choose an organization to continue.");
    expect(refused?.payload.detail).toBe(`user ${INSIDER} holds a membership but this session has selected nothing`);
  });

  test("a membership revoked mid-session refuses on the very next request", async () => {
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    expect((await call("/gated", { userId: INSIDER })).status).toBe(200);
    await db().deleteFrom(MEMBERSHIPS_TABLE).where("userId", "=", INSIDER).execute();
    // No sign-out, no cache to expire. Removing the row is the whole of revocation.
    expect((await call("/gated", { userId: INSIDER })).status).toBe(404);
  });
});

describe("the 404 a non-member gets is the 404 for an organization that does not exist", () => {
  test("the two rendered client payloads are equal", async () => {
    const notAMember = await call(`/named/${ACME}`, { userId: NEIGHBOR });
    const noSuchThing = await call(`/named/${ABSENT}`, { userId: NEIGHBOR });
    expect(notAMember.status).toBe(404);
    expect(noSuchThing.status).toBe(404);
    expect(await notAMember.json()).toEqual(await noSuchThing.json());
  });

  test("and neither body carries the organization's name, its slug, or a member's id", async () => {
    const body = await (await call(`/named/${ACME}`, { userId: NEIGHBOR })).text();
    expect(body).not.toContain("Acme");
    expect(body).not.toContain("acme");
    expect(body).not.toContain(INSIDER);
  });

  test("the distinction survives in `detail`, which the codec strips and the log keeps", async () => {
    await call(`/named/${ACME}`, { userId: NEIGHBOR });
    const notAMember = refused?.payload.detail;
    await call(`/named/${ABSENT}`, { userId: NEIGHBOR });
    const noSuchThing = refused?.payload.detail;
    expect(notAMember).toBe(`user ${NEIGHBOR} has no membership in organization ${ACME}`);
    expect(noSuchThing).toBe(`user ${NEIGHBOR} has no membership in organization ${ABSENT}`);
    // The ids differ, which is the operator's half of the answer; the client's half was identical.
    expect(notAMember).not.toBe(noSuchThing);
  });

  test("a role D1 holds that the catalog does not declare refuses with that same answer", async () => {
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    await env.DB.prepare("update pithy_organization_memberships set role = 'superuser' where user_id = ?")
      .bind(INSIDER)
      .run();
    const undeclared = await call("/gated", { userId: INSIDER });
    const notAMember = await call(`/named/${ACME}`, { userId: NEIGHBOR });
    expect(undeclared.status).toBe(404);
    expect(await undeclared.json()).toEqual(await notAMember.json());
  });

  test("a member of the named organization is let through, so the gate is a gate rather than a wall", async () => {
    const response = await call(`/named/${ACME}`, { userId: INSIDER });
    expect(response.status).toBe(200);
    // `chosen` is false: a route named this, nobody picked it.
    expect(await response.json()).toMatchObject({ organizationId: ACME, role: "admin", chosen: false });
  });

  test("a route that names an organization never falls back to the session when the name is absent", async () => {
    // The dangerous shape: a route written to act on the organization in its query would otherwise
    // sometimes act on whichever one the session had selected, and the request would read as a typo.
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    const response = await call("/named-query", { userId: INSIDER });
    expect(response.status).toBe(404);
    expect(refused?.payload.detail).toBe(
      "route declares a validated query named organizationId; the request carried none",
    );
  });

  test("a route that names an organization and declares no schema for it reads nothing, and refuses", async () => {
    // The gate reads through `c.req.valid`, so an undeclared contract is an empty one. Refusing is the
    // only safe reading: the alternative is a gate that reaches past the contract for a value nobody
    // validated, on the route where the value decides which tenant is reached.
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    const response = await call(`/named-undeclared/${ACME}`, { userId: INSIDER });
    expect(response.status).toBe(404);
    expect(refused?.payload.detail).toBe(
      "route declares a validated param named organizationId; the request carried none",
    );
  });

  test("the query form resolves the same way the path form does", async () => {
    const response = await call(`/named-query?organizationId=${ACME}`, { userId: INSIDER });
    expect(response.status).toBe(200);
  });
});

describe("requirePower — the catalog answers, and a 403 is earned", () => {
  test("a role that holds the power passes", async () => {
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    expect((await call("/read", { userId: INSIDER })).status).toBe(200);
  });

  test("a proved member whose role is short of the power gets a 403, not a 404", async () => {
    // By now they know the organization exists — they belong to it — so naming the shortfall leaks
    // nothing further and is the only answer that lets them ask somebody for the power.
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    const response = await call("/manage", { userId: INSIDER });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("organization/forbidden");
    expect(body.error.message).toContain("members:manage");
    expect(refused?.payload.detail).toBe(`role admin does not hold members:manage in organization ${ACME}`);
  });

  test("the owner of the same organization passes the same gate", async () => {
    await chooseActing(db(), { userId: OWNER, sessionId: SESSION, organizationId: ACME, now: NOW });
    expect((await call("/manage", { userId: OWNER })).status).toBe(200);
  });

  test("stacked without requireOrganization it refuses rather than reading a role off nothing", async () => {
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    const response = await call("/power-only", { userId: INSIDER });
    expect(response.status).toBe(403);
    expect(refused?.payload.detail).toContain("mount requireOrganization() first");
  });
});

describe("requireMayAssign — one function, and both doors call it", () => {
  // The function under test lives in `../members/members.ts`, and there is no copy of it in `guard.ts`.
  // That is the acceptance criterion rather than a tidiness preference: a curried second implementation
  // beside the other gates would be correct on the day it was written and one edit from disagreeing.
  // These cases drive it through a real route so the shape a handler spends it in is the shape tested.
  test("a role that administers may not be handed over by somebody without `members:manage`", async () => {
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    const response = await call("/assign?role=admin", { userId: INSIDER });
    expect(response.status).toBe(403);
    expect(refused?.payload.detail).toBe("role admin does not hold members:manage and may not assign admin");
  });

  test("somebody holding `members:manage` may hand it over", async () => {
    await chooseActing(db(), { userId: OWNER, sessionId: SESSION, organizationId: ACME, now: NOW });
    expect((await call("/assign?role=admin", { userId: OWNER })).status).toBe(200);
  });

  test("a role that does not administer is assignable by anybody the route already let through", async () => {
    await chooseActing(db(), { userId: INSIDER, sessionId: SESSION, organizationId: ACME, now: NOW });
    expect((await call("/assign?role=member", { userId: INSIDER })).status).toBe(200);
  });

  test("which roles administer is read off the catalog, never off the word `admin`", async () => {
    // A catalog whose administering role is spelled something else is governed identically. This is the
    // assertion that a rename or a fourth role does not quietly open the door.
    const academy = defineRoles({
      powers: ["sessions:read"],
      roles: {
        principal: [
          "organization:read",
          "organization:manage",
          "members:manage",
          "billing:manage",
          "organization:delete",
          "sessions:read",
        ],
        coach: ["organization:read", "sessions:read"],
      },
      administrativePower: "organization:manage",
    });
    expect(() => requireMayAssign(academy, "coach", "principal")).toThrow(PithyError);
    expect(() => requireMayAssign(academy, "coach", "coach")).not.toThrow();
  });
});
