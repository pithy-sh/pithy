// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "@pithy-sh/auth/src/migrations/0001_init";
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
import { chooseActing } from "../acting/acting";
import { OrganizationConfig } from "../config/config";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import {
  ACTING_TABLE,
  INVITATIONS_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
import type { EnqueueInvitation } from "../mail/invitation";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "../migrations/0001_init";
import type { OwnershipRoles } from "../ownership/ownership";
import { defineRoles } from "../roles/roles";
import { registerOrganizationRoutes } from "./routes";
import { ORGANIZATION_ACCOUNTS_READ_SCOPE, ORGANIZATION_MEMBERS_READ_SCOPE } from "./scopes";

/**
 * Every route, over real D1, through a real Hono app with the real error codec.
 *
 * **The security properties here are query shapes and rendered bytes, and neither survives a mock.** The
 * byte-identical 404 is not a claim about how two errors are *constructed* — it is a claim about what two
 * clients receive, so it is asserted on what `pithyErrorHandler` actually wrote. Revocation is not a
 * claim about a function — it is a claim that deleting one row changes the answer of the next request,
 * which only a database can demonstrate. And "the token is stored as a digest" is a claim about a column.
 *
 * The session is seeded from headers rather than from a real sign-in: `@pithy-sh/auth` is what proves an
 * identity, and proving it twice here would test that package instead of this one. Everything downstream
 * of the identity — the membership, the role, the selection — is read from D1 exactly as it is in
 * production.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ABSENT = "99999999-9999-4999-8999-999999999999";

const ADA = "user_ada";
const BOB = "user_bob";
const CAI = "user_cai";
const STRANGER = "user_stranger";

const SESSION = "session_main";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const BASE = "/organizations";

// A 1×1 PNG, small enough to read and real enough to decode.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

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
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_migrations",
  "pithy_migrations_lock",
];

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
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

/** One person in `pithy_auth_users`. Written raw, because the writer is Better Auth's and not ours. */
async function seedUser(
  id: string,
  fields: { name?: string; email?: string; image?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, image, locale, created_at, updated_at) values (?, ?, ?, 1, ?, null, ?, ?)",
  )
    .bind(
      id,
      fields.name ?? `Person ${id}`,
      fields.email ?? `${id}@example.com`,
      fields.image ?? null,
      NOW.toISOString(),
      NOW.toISOString(),
    )
    .run();
}

async function seedOrganization(id: string, name: string, slug: string, logo: string | null = null): Promise<void> {
  await db()
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id, name, slug, logo, createdAt: NOW, updatedAt: NOW }))
    .execute();
}

/**
 * One membership.
 *
 * `joinedAt` is offset per row on purpose: the roster is ordered by `createdAt` with the id as the
 * tiebreak, and three rows written in the same millisecond would come back in whatever order the ids
 * happened to sort in — a test that passed or failed on `crypto.randomUUID`.
 */
async function seedMembership(organizationId: string, userId: string, role: Role, joinedAfterMs = 0): Promise<string> {
  const id = crypto.randomUUID();
  await db()
    .insertInto(MEMBERSHIPS_TABLE)
    .values(Membership.encode({ id, organizationId, userId, role, createdAt: new Date(NOW.getTime() + joinedAfterMs) }))
    .execute();
  return id;
}

async function membershipIdOf(organizationId: string, userId: string): Promise<string> {
  const row = await db()
    .selectFrom(MEMBERSHIPS_TABLE)
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** What the app enqueued, and what it recorded. Both are assertions the routes exist to make. */
let mailed: { to: string; template: string; payload: unknown }[] = [];
let events: AuditEventInput[] = [];
/** The last fault, so a test can read the `detail` the wire deliberately never carries. */
let refused: PithyError | null = null;

const enqueue: EnqueueInvitation = async (input) => {
  mailed.push({ to: input.to, template: input.template, payload: input.payload });
  return { jobId: "job-1", status: "queued" };
};

/** The accept link the capability enqueued, read back the way a recipient's mail client would. */
function mailedAcceptUrl(): string {
  const first = mailed[0];
  if (!first) throw new Error("expected an invitation to have been enqueued");
  return (first.payload as { acceptUrl: string }).acceptUrl;
}

/** The plaintext token from that link — the one copy of it that exists outside the mail. */
function mailedToken(): string {
  const token = mailedAcceptUrl().split("/").pop();
  if (!token) throw new Error("expected the accept link to end in a token");
  return token;
}

const emit: AuditEmit = async (event) => {
  events.push(event);
};

/** A permissive published origin policy — the state a Worker that composed auth is in. */
const allowAnyOrigin: SameOriginGate = async (_c, next) => {
  await next();
};

/** A management caller holding one scope. `requireControlPlane` asks the verifier and nothing else. */
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
    } satisfies ControlPlaneContext;
  };
}

interface AppOptions {
  readonly config?: Partial<Parameters<typeof OrganizationConfig.parse>[0]>;
  readonly ownership?: OwnershipRoles<Role> | null;
  readonly sameOrigin?: SameOriginGate | null;
  readonly verifier?: ControlPlaneVerifier | null;
  readonly mail?: boolean;
}

function buildApp(options: AppOptions = {}): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError((error, c) => {
    refused = error instanceof PithyError ? error : null;
    return pithyErrorHandler(error, c);
  });
  app.use("*", async (c, next) => {
    const userId = c.req.header("x-test-user");
    const sessionId = c.req.header("x-test-session") ?? SESSION;
    c.set("auth", userId ? AuthContext.parse({ userId, sessionId, scopes: [], locale: null }) : null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", options.verifier ?? null);
    c.set("sameOrigin", options.sameOrigin === undefined ? allowAnyOrigin : options.sameOrigin);
    c.set("emit", emit);
    c.set("log", noopLogger);
    await next();
  });
  registerOrganizationRoutes({
    catalog,
    config: OrganizationConfig.parse({ baseUrl: "https://app.example.test", ...options.config }),
    ownership: options.ownership === null ? undefined : (options.ownership ?? OWNERSHIP),
    enqueue: options.mail === false ? undefined : () => enqueue,
    now: () => NOW,
  })(app);
  return app;
}

let app: Hono<PithyHonoEnv>;

interface CallOptions {
  readonly as?: string;
  readonly session?: string;
  readonly body?: unknown;
  readonly app?: Hono<PithyHonoEnv>;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.as) headers["x-test-user"] = options.as;
  if (options.session) headers["x-test-session"] = options.session;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await (options.app ?? app).request(
    path,
    { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) },
    { DB: env.DB } as unknown as Record<string, unknown>,
  );
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function actionsRecorded(): string[] {
  return events.map((event) => event.action);
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());

  await seedUser(ADA, { name: "Ada Lovelace", email: "ada@example.com" });
  await seedUser(BOB, { name: "Bob Stone", email: "bob@example.com" });
  await seedUser(CAI, { name: "Cai Rivers", email: "cai@example.com", image: PNG });
  await seedUser(STRANGER, { name: "Sam Stranger", email: "sam@example.com" });

  await seedOrganization(ACME, "Acme Games", "acme", PNG);
  await seedOrganization(BETA, "Beta Studio", "beta");
  await seedMembership(ACME, ADA, "owner", 0);
  await seedMembership(ACME, BOB, "admin", 1_000);
  await seedMembership(ACME, CAI, "member", 2_000);
  await seedMembership(BETA, STRANGER, "owner");

  mailed = [];
  events = [];
  refused = null;
  app = buildApp();
});

describe("the chooser", () => {
  test("lists only what the caller may act in, with their own role in each", async () => {
    await seedMembership(BETA, ADA, "member");
    const response = await call("GET", BASE, { as: ADA });
    expect(response.status).toBe(200);
    const body = await json<{
      organizations: { id: string; role: string; mark: string | null }[];
      acting: string | null;
      chosen: boolean;
    }>(response);
    // Ordered by name, which is the order the chooser lists them in.
    expect(body.organizations.map((organization) => organization.id)).toEqual([ACME, BETA]);
    // The reader's own standing, never the row's. An organization has as many answers to "what may you
    // do here" as it has members.
    expect(body.organizations.map((organization) => organization.role)).toEqual(["owner", "member"]);
    expect(body.acting).toBeNull();
    expect(body.chosen).toBe(false);
    // A raster becomes a versioned URL a browser caches; the version is the row's `updatedAt`.
    expect(body.organizations[0]?.mark).toBe(`${BASE}/marks/organization/${ACME}?v=${NOW.getTime()}`);
    expect(body.organizations[1]?.mark).toBeNull();
  });

  test("a stranger to every account gets an empty list rather than a refusal", async () => {
    await seedUser("user_nobody");
    const body = await json<{ organizations: unknown[]; acting: null }>(await call("GET", BASE, { as: "user_nobody" }));
    expect(body.organizations).toEqual([]);
    expect(body.acting).toBeNull();
  });

  test("choosing writes the selection and reads it back off the row", async () => {
    const response = await call("POST", `${BASE}/acting`, { as: CAI, body: { organizationId: ACME } });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      organizationId: ACME,
      name: "Acme Games",
      slug: "acme",
      role: "member",
      chosen: true,
    });
    const row = await db().selectFrom(ACTING_TABLE).selectAll().where("sessionId", "=", SESSION).executeTakeFirst();
    expect(row?.organizationId).toBe(ACME);
    // `chosen` is written even for somebody who had one account to pick from. The chooser keys on it.
    expect(row?.chosen).toBe(1);
  });

  test("a selection made for one session does not answer for another", async () => {
    await call("POST", `${BASE}/acting`, { as: CAI, body: { organizationId: ACME } });
    const other = await call("GET", `${BASE}/current`, { as: CAI, session: "session_other" });
    expect(other.status).toBe(404);
  });
});

describe("the 404 is one answer to two facts, and that is the security property", () => {
  test("an organization the caller is not in renders byte-identically to one that does not exist", async () => {
    const notMine = await call("POST", `${BASE}/acting`, { as: CAI, body: { organizationId: BETA } });
    const mineDetail = refused?.payload.detail;
    const nowhere = await call("POST", `${BASE}/acting`, { as: CAI, body: { organizationId: ABSENT } });
    const nowhereDetail = refused?.payload.detail;

    expect(notMine.status).toBe(404);
    expect(nowhere.status).toBe(404);
    // The whole claim: what two clients receive, compared on the rendered bytes rather than on how the
    // two errors were constructed. A caller who could tell these apart could iterate ids and read out
    // the tenant list.
    expect(await notMine.text()).toBe(await nowhere.text());

    // And the distinction an operator needs survives in `detail`, which the codec strips.
    expect(mineDetail).toContain(BETA);
    expect(nowhereDetail).toContain(ABSENT);
    expect(mineDetail).not.toBe(nowhereDetail);
  });

  test("a membership id from another account renders byte-identically to one that never existed", async () => {
    const foreign = await membershipIdOf(BETA, STRANGER);
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });

    const elsewhere = await call("DELETE", `${BASE}/current/members/${foreign}`, { as: ADA });
    const invented = await call("DELETE", `${BASE}/current/members/${ABSENT}`, { as: ADA });
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).toBe(await invented.text());
  });

  test("a membership row holding a role this build cannot name is the same 404, not a 500", async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
    const cai = await membershipIdOf(ACME, CAI);
    // Written straight to D1, the way a repair script or an older build would.
    await env.DB.prepare("update pithy_organization_memberships set role = ? where id = ?").bind("wizard", cai).run();

    const junk = await call("DELETE", `${BASE}/current/members/${cai}`, { as: ADA });
    const invented = await call("DELETE", `${BASE}/current/members/${ABSENT}`, { as: ADA });
    expect(junk.status).toBe(404);
    expect(await junk.text()).toBe(await invented.text());
  });
});

describe("no organization in force", () => {
  test("the refusal names no organization, because there is none to name", async () => {
    await seedUser("user_nobody");
    const unchosen = await json<{ error: { message: string } }>(await call("GET", `${BASE}/current`, { as: ADA }));
    const unchosenAction = refused?.payload.action;
    const nowhere = await json<{ error: { message: string } }>(
      await call("GET", `${BASE}/current`, { as: "user_nobody" }),
    );
    const nowhereAction = refused?.payload.action;

    // Distinct in wording from "that organization does not exist", which is the other thing this code
    // says — and it may be said plainly, because it is a fact about the caller's own rows rather than
    // about somebody else's account.
    expect(unchosen.error.message).toBe("No organization is in force.");
    expect(nowhere.error.message).toBe("No organization is in force.");
    expect(JSON.stringify(unchosen)).not.toContain(ACME);

    // The second sentence — choose, or go and get invited — rides in `action`, which the HTTP codec
    // strips along with `detail`. So the two are one answer on the wire and two in the log; a client
    // that wants to tell them apart asks `GET {base}` and looks at the length of the list.
    expect(unchosenAction).toBe("Choose an organization to continue.");
    expect(nowhereAction).toBe("Join or create an organization to continue.");
  });

  test("a stored selection whose membership is gone is no selection, not a refusal — and the next request says so", async () => {
    await chooseActing(db(), { userId: CAI, sessionId: SESSION, organizationId: ACME, now: NOW });
    expect((await call("GET", `${BASE}/current`, { as: CAI })).status).toBe(200);

    // Revocation is one DELETE, and it takes effect on the next request with no sign-out and no cache.
    await db().deleteFrom(MEMBERSHIPS_TABLE).where("organizationId", "=", ACME).where("userId", "=", CAI).execute();
    const after = await call("GET", `${BASE}/current`, { as: CAI });
    expect(after.status).toBe(404);
    // Not "that organization does not exist" — the selection resolved to nothing rather than refusing,
    // and Cai may still belong elsewhere. `action` never reaches a client, so it is read off the fault.
    expect(refused?.payload.action).toBe("Join or create an organization to continue.");
  });
});

describe("the account in force", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
  });

  test("the record carries the account, the reader's role, and counts", async () => {
    const body = await json<{
      organization: { name: string; role: string };
      totals: { members: number; invitations: number | null };
    }>(await call("GET", `${BASE}/current`, { as: ADA }));
    expect(body.organization.name).toBe("Acme Games");
    expect(body.organization.role).toBe("owner");
    expect(body.totals.members).toBe(3);
    expect(body.totals.invitations).toBe(0);
  });

  test("a reader who cannot manage the account is told null, not zero, about its offers", async () => {
    await chooseActing(db(), { userId: CAI, sessionId: "session_cai", organizationId: ACME, now: NOW });
    const body = await json<{ totals: { invitations: number | null } }>(
      await call("GET", `${BASE}/current`, { as: CAI, session: "session_cai" }),
    );
    // Zero would be this record answering a question it declined to read.
    expect(body.totals.invitations).toBeNull();
  });

  test("renaming takes `organization:manage`, and records the new name and nothing else", async () => {
    await chooseActing(db(), { userId: CAI, sessionId: "session_cai", organizationId: ACME, now: NOW });
    const refusedRename = await call("PATCH", `${BASE}/current`, {
      as: CAI,
      session: "session_cai",
      body: { name: "Not Allowed" },
    });
    expect(refusedRename.status).toBe(403);

    const done = await call("PATCH", `${BASE}/current`, { as: ADA, body: { name: "Acme Interactive" } });
    expect(done.status).toBe(200);
    expect((await json<{ organization: { name: string } }>(done)).organization.name).toBe("Acme Interactive");
    expect(actionsRecorded()).toEqual(["organization/renamed"]);
    expect(events[0]?.metadata).toMatchObject({ name: "Acme Interactive" });
  });

  test("absent leaves the mark; null takes it off — two instructions one nullable field could not carry", async () => {
    await call("PATCH", `${BASE}/current`, { as: ADA, body: { name: "Acme Interactive" } });
    let row = await db().selectFrom(ORGANIZATIONS_TABLE).select("logo").where("id", "=", ACME).executeTakeFirst();
    expect(row?.logo).toBe(PNG);

    await call("PATCH", `${BASE}/current`, { as: ADA, body: { logo: null } });
    row = await db().selectFrom(ORGANIZATIONS_TABLE).select("logo").where("id", "=", ACME).executeTakeFirst();
    expect(row?.logo).toBeNull();
    expect(actionsRecorded()).toEqual(["organization/renamed", "organization/logo_changed"]);
  });

  test("an empty body is not a change", async () => {
    expect((await call("PATCH", `${BASE}/current`, { as: ADA, body: {} })).status).toBe(400);
  });

  test("deleting takes `organization:delete`, and takes every claim on the account with it", async () => {
    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    // An admin runs the roster and does not end the account. The power is named, never the role.
    expect((await call("DELETE", `${BASE}/current`, { as: BOB, session: "session_bob" })).status).toBe(403);

    const gone = await call("DELETE", `${BASE}/current`, { as: ADA });
    expect(gone.status).toBe(200);
    expect(await json(gone)).toEqual({ organizationId: ACME });
    expect(await db().selectFrom(MEMBERSHIPS_TABLE).select("id").where("organizationId", "=", ACME).execute()).toEqual(
      [],
    );
    // The selection went with it, so no live session is left pointed at an account that is not there.
    expect(
      await db().selectFrom(ACTING_TABLE).select("sessionId").where("organizationId", "=", ACME).execute(),
    ).toEqual([]);
  });
});

describe("the roster", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
  });

  test("names and addresses come from the auth capability's own reader", async () => {
    const body = await json<{
      members: { userId: string; name: string | null; email: string | null; mark: string | null; role: string }[];
    }>(await call("GET", `${BASE}/current/members`, { as: ADA }));
    expect(body.members.map((member) => member.userId)).toEqual([ADA, BOB, CAI]);
    expect(body.members.map((member) => member.email)).toEqual([
      "ada@example.com",
      "bob@example.com",
      "cai@example.com",
    ]);
    const cai = body.members[2];
    expect(cai?.mark).toContain(`${BASE}/members/`);
    expect(cai?.mark).toContain("/image?v=");
  });

  test("a membership that outlived its user row draws the gap rather than failing the screen", async () => {
    await env.DB.prepare("delete from pithy_auth_users where id = ?").bind(CAI).run();
    const body = await json<{ members: { userId: string; name: string | null; email: string | null }[] }>(
      await call("GET", `${BASE}/current/members`, { as: ADA }),
    );
    expect(body.members).toHaveLength(3);
    expect(body.members[2]).toMatchObject({ userId: CAI, name: null, email: null });
  });

  test("changing a role takes `organization:manage`", async () => {
    await chooseActing(db(), { userId: CAI, sessionId: "session_cai", organizationId: ACME, now: NOW });
    const target = await membershipIdOf(ACME, BOB);
    const denied = await call("PATCH", `${BASE}/current/members/${target}`, {
      as: CAI,
      session: "session_cai",
      body: { role: "member" },
    });
    expect(denied.status).toBe(403);

    const changed = await call("PATCH", `${BASE}/current/members/${target}`, { as: ADA, body: { role: "member" } });
    expect(changed.status).toBe(200);
    expect(await json(changed)).toEqual({ member: { membershipId: target, userId: BOB, role: "member" } });
    expect(actionsRecorded()).toEqual(["organization/member_role_changed"]);
  });

  test("the role a transfer confers cannot be handed over by a role change, by anybody", async () => {
    const target = await membershipIdOf(ACME, BOB);
    // Ada holds every power in the catalog. Assignability is derived by exclusion, and `owner` is excluded,
    // so there is no role change that makes somebody the owner of an account.
    const response = await call("PATCH", `${BASE}/current/members/${target}`, { as: ADA, body: { role: "owner" } });
    expect(response.status).toBe(400);
    expect(await db().selectFrom(MEMBERSHIPS_TABLE).select("role").where("id", "=", target).executeTakeFirst()).toEqual(
      {
        role: "admin",
      },
    );
  });

  test("minting an administrator takes `members:manage`, not merely `organization:manage`", async () => {
    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    const target = await membershipIdOf(ACME, CAI);
    // Bob runs the roster. He does not hold `members:manage`, so he cannot install a second administrator
    // at his own level — which is the pair of them handing the account between themselves.
    const denied = await call("PATCH", `${BASE}/current/members/${target}`, {
      as: BOB,
      session: "session_bob",
      body: { role: "admin" },
    });
    expect(denied.status).toBe(403);

    const allowed = await call("PATCH", `${BASE}/current/members/${target}`, { as: ADA, body: { role: "admin" } });
    expect(allowed.status).toBe(200);
  });

  test("removing somebody is a different audited event from their leaving", async () => {
    const cai = await membershipIdOf(ACME, CAI);
    const removed = await call("DELETE", `${BASE}/current/members/${cai}`, { as: ADA });
    expect(await json(removed)).toEqual({ membershipId: cai, left: false });
    expect(actionsRecorded()).toEqual(["organization/member_removed"]);

    events = [];
    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    const bob = await membershipIdOf(ACME, BOB);
    const left = await call("POST", `${BASE}/current/members/leave`, { as: BOB, session: "session_bob" });
    expect(await json(left)).toEqual({ membershipId: bob, left: true });
    expect(actionsRecorded()).toEqual(["organization/member_left"]);
  });

  test("the last holder of the administrative power cannot leave, and cannot be removed", async () => {
    // Ada goes, so Bob — an `admin` — is the only member left who administers. Counted over the *power*,
    // never over a role spelled `admin`: this is the same check that lets an owner-plus-admin account
    // lose its admin without complaint.
    await db().deleteFrom(MEMBERSHIPS_TABLE).where("organizationId", "=", ACME).where("userId", "=", ADA).execute();
    const bob = await membershipIdOf(ACME, BOB);
    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });

    expect((await call("POST", `${BASE}/current/members/leave`, { as: BOB, session: "session_bob" })).status).toBe(409);
    expect((await call("DELETE", `${BASE}/current/members/${bob}`, { as: BOB, session: "session_bob" })).status).toBe(
      409,
    );
    expect(await db().selectFrom(MEMBERSHIPS_TABLE).select("id").where("id", "=", bob).executeTakeFirst()).toBeTruthy();
  });

  test("the holder of a role that arrived by transfer has no exit that is not another transfer", async () => {
    // Ada is the `owner`, and `owner` is excluded from assignment — so it arrived by a path that is not
    // assignment, and this surface, which exists to undo assignments, refuses to undo it. A 403 rather
    // than the floor's 409: the account has another administrator, so the floor is not what stops her.
    const ada = await membershipIdOf(ACME, ADA);
    expect((await call("POST", `${BASE}/current/members/leave`, { as: ADA })).status).toBe(403);
    expect((await call("DELETE", `${BASE}/current/members/${ada}`, { as: ADA })).status).toBe(403);
  });
});

describe("invitations", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
  });

  test("inviting mails the link, returns none, and stores only a digest", async () => {
    const response = await call("POST", `${BASE}/current/invitations`, {
      as: ADA,
      body: { email: "New.Person@Example.com", role: "member" },
    });
    expect(response.status).toBe(201);
    const body = await json<{ invitation: { id: string; email: string; role: string }; acceptUrl: string | null }>(
      response,
    );
    // Null, because the capability mailed it. The token is then in the mail and in no response body,
    // which is the whole point of putting it there.
    expect(body.acceptUrl).toBeNull();
    expect(body.invitation.email).toBe("new.person@example.com");
    expect(mailed).toHaveLength(1);
    expect(mailed[0]?.to).toBe("new.person@example.com");
    const token = mailedToken();

    // The plaintext is in the mail and in no row. A dumped table must not yield a live credential.
    const rows = await env.DB.prepare("select * from pithy_organization_invitations").all();
    expect(JSON.stringify(rows.results)).not.toContain(token);

    // And the trail records the offer's id and the role — never the address, and never the token.
    expect(actionsRecorded()).toEqual(["organization/member_invited"]);
    const recorded = JSON.stringify(events[0]);
    expect(recorded).not.toContain("new.person@example.com");
    expect(recorded).not.toContain(token);
  });

  test("a project that mails invitations itself is handed the link instead", async () => {
    const own = buildApp({ config: { sendInvitationEmail: false } });
    const body = await json<{ acceptUrl: string | null }>(
      await call("POST", `${BASE}/current/invitations`, {
        as: ADA,
        body: { email: "other@example.com", role: "member" },
        app: own,
      }),
    );
    expect(body.acceptUrl).toContain("https://app.example.test/organizations/invitations/");
    expect(mailed).toHaveLength(0);
  });

  test("offering an administering role is the same rule as promoting to one", async () => {
    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    const denied = await call("POST", `${BASE}/current/invitations`, {
      as: BOB,
      session: "session_bob",
      body: { email: "new@example.com", role: "admin" },
    });
    expect(denied.status).toBe(403);
    // Refused before anything was written, and before anything was sent.
    expect(await db().selectFrom(INVITATIONS_TABLE).select("id").execute()).toEqual([]);
    expect(mailed).toHaveLength(0);
  });

  test("a role the catalog will not let anybody hand out is refused, and nothing is written", async () => {
    const response = await call("POST", `${BASE}/current/invitations`, {
      as: ADA,
      body: { email: "new@example.com", role: "owner" },
    });
    expect(response.status).toBe(403);
    expect(await db().selectFrom(INVITATIONS_TABLE).select("id").execute()).toEqual([]);
  });

  test("listing and withdrawing take `organization:manage`; a withdrawal is a state change, not a delete", async () => {
    await call("POST", `${BASE}/current/invitations`, { as: ADA, body: { email: "new@example.com", role: "member" } });
    const listed = await json<{ invitations: { id: string; status: string }[] }>(
      await call("GET", `${BASE}/current/invitations`, { as: ADA }),
    );
    expect(listed.invitations).toHaveLength(1);
    const id = listed.invitations[0]?.id as string;

    await chooseActing(db(), { userId: CAI, sessionId: "session_cai", organizationId: ACME, now: NOW });
    expect((await call("GET", `${BASE}/current/invitations`, { as: CAI, session: "session_cai" })).status).toBe(403);

    const withdrawn = await call("DELETE", `${BASE}/current/invitations/${id}`, { as: ADA });
    expect(withdrawn.status).toBe(200);
    expect((await json<{ invitation: { status: string } }>(withdrawn)).invitation.status).toBe("canceled");
    // The row stays as history: "we invited them and thought better of it" is a different account of a
    // fortnight from "we never invited them".
    const row = await db().selectFrom(INVITATIONS_TABLE).select("status").where("id", "=", id).executeTakeFirst();
    expect(row?.status).toBe("canceled");
  });

  test("no response anywhere carries the token or its digest", async () => {
    await call("POST", `${BASE}/current/invitations`, { as: ADA, body: { email: "new@example.com", role: "member" } });
    const listed = await (await call("GET", `${BASE}/current/invitations`, { as: ADA })).text();
    const digest = await db().selectFrom(INVITATIONS_TABLE).select("tokenDigest").executeTakeFirstOrThrow();
    expect(listed).not.toContain(digest.tokenDigest);
    const token = mailedToken();
    expect(listed).not.toContain(token);
  });
});

describe("resending an offer", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
  });

  /** Invite somebody and hand back the offer's id and the token that was mailed. */
  async function invited(role = "member"): Promise<{ id: string; token: string }> {
    const response = await call("POST", `${BASE}/current/invitations`, {
      as: ADA,
      body: { email: "new.person@example.com", role },
    });
    const body = await json<{ invitation: { id: string } }>(response);
    const token = mailedToken();
    mailed.length = 0;
    events.length = 0;
    return { id: body.invitation.id, token };
  }

  test("mints a new token, kills the old one, and mails the replacement", async () => {
    // One live token per offer. Mailing the same one again would mean an address that received two
    // mails holds two working links, so a withdrawal later leaves whichever copy somebody kept working.
    const first = await invited();
    const response = await call("POST", `${BASE}/current/invitations/${first.id}/resend`, { as: ADA });
    expect(response.status).toBe(200);
    expect(mailed).toHaveLength(1);

    const second = mailedToken();
    expect(second).not.toBe(first.token);
    // The old link now matches nothing — checked through the public accept-screen read, which is the
    // only thing a holder of the old token can reach.
    expect((await call("GET", `${BASE}/invitations/${first.token}`)).status).toBe(400);
    expect((await call("GET", `${BASE}/invitations/${second}`)).status).toBe(200);
    expect(actionsRecorded()).toEqual(["organization/invitation_resent"]);
  });

  test("neither token appears in any row", async () => {
    const first = await invited();
    await call("POST", `${BASE}/current/invitations/${first.id}/resend`, { as: ADA });
    const rows = JSON.stringify((await env.DB.prepare("select * from pithy_organization_invitations").all()).results);
    expect(rows).not.toContain(first.token);
    expect(rows).not.toContain(mailedToken());
  });

  test("spends the assignment rule again, on the role the row holds rather than the request's", async () => {
    // **The reason a resend is gated at all.** It revives an offer of a role, so it is the same act as
    // making it: somebody who could not offer an administering role today must not be able to re-offer
    // one that was made when they could.
    const offer = await call("POST", `${BASE}/current/invitations`, {
      as: ADA,
      body: { email: "future.admin@example.com", role: "admin" },
    });
    expect(offer.status).toBe(201);
    const { invitation } = await json<{ invitation: { id: string } }>(offer);
    mailed.length = 0;

    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    const denied = await call("POST", `${BASE}/current/invitations/${invitation.id}/resend`, {
      as: BOB,
      session: "session_bob",
    });
    expect(denied.status).toBe(403);
    // Nothing sent, and the offer untouched — no new digest, so the first link still works.
    expect(mailed).toHaveLength(0);
  });

  test("another organization's offer is the same refusal as one that does not exist", async () => {
    // Both halves in one predicate. An invitation found by id alone would be another account's row
    // handed to a handler that checked the caller's power in theirs — and since the two refusals are
    // byte-identical, guessing a UUID tells a member of one account nothing about another's.
    await chooseActing(db(), { userId: STRANGER, sessionId: "session_stranger", organizationId: BETA, now: NOW });
    const theirs = await call("POST", `${BASE}/current/invitations`, {
      as: STRANGER,
      session: "session_stranger",
      body: { email: "beta.person@example.com", role: "member" },
    });
    expect(theirs.status).toBe(201);
    const { invitation } = await json<{ invitation: { id: string } }>(theirs);
    mailed.length = 0;

    const other = await call("POST", `${BASE}/current/invitations/${invitation.id}/resend`, { as: ADA });
    const absent = await call("POST", `${BASE}/current/invitations/${crypto.randomUUID()}/resend`, { as: ADA });
    expect(other.status).toBe(absent.status);
    expect(await other.text()).toBe(await absent.text());
    // And nothing was sent for either.
    expect(mailed).toHaveLength(0);
  });
});

describe("the link in the mail", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
    await call("POST", `${BASE}/current/invitations`, { as: ADA, body: { email: "bob@example.com", role: "member" } });
  });

  test("resolves, with no session, to the three facts an accept screen renders — and nothing else", async () => {
    const response = await call("GET", `${BASE}/invitations/${mailedToken()}`);
    expect(response.status).toBe(200);
    const body = await json<Record<string, unknown>>(response);
    expect(body).toEqual({
      organizationName: "Acme Games",
      inviterName: "Ada Lovelace",
      role: "member",
      expiresAt: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
    });
    // Not the invited address, not the offer's id, not the sender's user id. A forwarded link must not
    // become a read of the account's own records.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("bob@example.com");
    expect(raw).not.toContain(ADA);
  });

  test("every unredeemable form of it says the same sentence", async () => {
    const unknown = await call("GET", `${BASE}/invitations/not-a-real-token`);
    const unknownBody = await unknown.text();

    const token = mailedToken();
    const id = (await db().selectFrom(INVITATIONS_TABLE).select("id").executeTakeFirstOrThrow()).id;
    await call("DELETE", `${BASE}/current/invitations/${id}`, { as: ADA });
    const withdrawn = await call("GET", `${BASE}/invitations/${token}`);

    expect(unknown.status).toBe(400);
    expect(withdrawn.status).toBe(400);
    // Telling somebody which it was tells whoever a link was forwarded to exactly the same thing.
    expect(await withdrawn.text()).toBe(unknownBody);
  });
});

describe("redeeming an offer", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
  });

  async function inviteTo(email: string, role: Role = "member"): Promise<string> {
    mailed = [];
    await call("POST", `${BASE}/current/invitations`, { as: ADA, body: { email, role } });
    return mailedToken();
  }

  test("a valid token presented by the wrong address is refused", async () => {
    const token = await inviteTo("newcomer@example.com");
    await seedUser("user_wrong", { email: "wrong@example.com" });
    const response = await call("POST", `${BASE}/invitations/accept`, { as: "user_wrong", body: { token } });
    expect(response.status).toBe(400);
    // The binding is what makes a forwarded link useless. Nothing was written.
    expect(await db().selectFrom(MEMBERSHIPS_TABLE).select("id").where("userId", "=", "user_wrong").execute()).toEqual(
      [],
    );
  });

  test("the invited address joins, at the role the offer carried", async () => {
    await seedUser("user_new", { email: "newcomer@example.com" });
    const token = await inviteTo("newcomer@example.com");
    events = [];
    const response = await call("POST", `${BASE}/invitations/accept`, { as: "user_new", body: { token } });
    expect(response.status).toBe(200);
    const body = await json<{ organizationId: string; role: string; joined: boolean }>(response);
    expect(body).toMatchObject({ organizationId: ACME, role: "member", joined: true });
    expect(actionsRecorded()).toEqual(["organization/member_joined"]);

    // Joining and looking are two acts: the offer does not move what this session is acting in.
    const acting = await db()
      .selectFrom(ACTING_TABLE)
      .select("organizationId")
      .where("sessionId", "=", SESSION)
      .executeTakeFirst();
    expect(acting?.organizationId).toBe(ACME);
  });

  test("redeeming twice is idempotent, and says so", async () => {
    const token = await inviteTo("bob@example.com");
    const body = await json<{ joined: boolean }>(
      await call("POST", `${BASE}/invitations/accept`, { as: BOB, body: { token } }),
    );
    // Already inside. The offer is consumed anyway, because leaving it pending leaves a live token for
    // somebody who is already a member.
    expect(body.joined).toBe(false);
    const again = await call("POST", `${BASE}/invitations/accept`, { as: BOB, body: { token } });
    expect(again.status).toBe(400);
  });

  test("the route is not gated by a membership, because the caller does not have one yet", async () => {
    await seedUser("user_new", { email: "newcomer@example.com" });
    const token = await inviteTo("newcomer@example.com");
    // No acting selection, no membership anywhere — and it still works. A gate proving a membership here
    // would refuse every legitimate use.
    const response = await call("POST", `${BASE}/invitations/accept`, {
      as: "user_new",
      session: "session_fresh",
      body: { token },
    });
    expect(response.status).toBe(200);
  });
});

describe("ownership moves only by offer and acceptance", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
  });

  test("nominating takes `billing:manage`, and moves nothing on its own", async () => {
    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    const target = await membershipIdOf(ACME, BOB);
    expect(
      (
        await call("POST", `${BASE}/current/ownership`, {
          as: BOB,
          session: "session_bob",
          body: { membershipId: target },
        })
      ).status,
    ).toBe(403);

    const offered = await call("POST", `${BASE}/current/ownership`, { as: ADA, body: { membershipId: target } });
    expect(offered.status).toBe(201);
    // An offer, not a transfer. Nobody's role changed.
    expect(await db().selectFrom(MEMBERSHIPS_TABLE).select("role").where("id", "=", target).executeTakeFirst()).toEqual(
      {
        role: "admin",
      },
    );
    expect(actionsRecorded()).toEqual(["organization/ownership_nominated"]);
  });

  test("only the nominee may accept, and accepting demotes the previous holder in the same write", async () => {
    const bob = await membershipIdOf(ACME, BOB);
    await call("POST", `${BASE}/current/ownership`, { as: ADA, body: { membershipId: bob } });
    await chooseActing(db(), { userId: CAI, sessionId: "session_cai", organizationId: ACME, now: NOW });

    // Somebody else accepting on the nominee's behalf is exactly the click this design makes impossible.
    expect((await call("POST", `${BASE}/ownership/accept`, { as: CAI, session: "session_cai" })).status).toBe(400);

    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    const accepted = await call("POST", `${BASE}/ownership/accept`, { as: BOB, session: "session_bob" });
    expect(accepted.status).toBe(200);
    const body = await json<{ newHolderMembershipId: string; previousHolderMembershipIds: string[] }>(accepted);
    expect(body.newHolderMembershipId).toBe(bob);
    expect(body.previousHolderMembershipIds).toEqual([await membershipIdOf(ACME, ADA)]);

    const roles = await db()
      .selectFrom(MEMBERSHIPS_TABLE)
      .select(["userId", "role"])
      .where("organizationId", "=", ACME)
      .execute();
    // Handing the account on is not leaving the company: the previous holder falls back rather than out.
    expect(roles.find((row) => row.userId === ADA)?.role).toBe("admin");
    expect(roles.find((row) => row.userId === BOB)?.role).toBe("owner");
  });

  test("withdrawing an offer takes `billing:manage` and leaves nothing standing", async () => {
    const bob = await membershipIdOf(ACME, BOB);
    await call("POST", `${BASE}/current/ownership`, { as: ADA, body: { membershipId: bob } });
    const withdrawn = await call("DELETE", `${BASE}/current/ownership`, { as: ADA });
    expect(withdrawn.status).toBe(200);
    expect(await json(withdrawn)).toEqual({ nomination: null });

    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    expect((await call("POST", `${BASE}/ownership/accept`, { as: BOB, session: "session_bob" })).status).toBe(400);
  });

  test("a project with no transfer declared mounts no transfer routes at all", async () => {
    const plain = buildApp({ ownership: null });
    const bob = await membershipIdOf(ACME, BOB);
    // Not a refusal a caller has to interpret — the routes are not there, because for this project the
    // two-party transfer is not a feature that is broken but a feature that does not exist.
    expect(
      (await call("POST", `${BASE}/current/ownership`, { as: ADA, body: { membershipId: bob }, app: plain })).status,
    ).toBe(404);
    expect((await call("POST", `${BASE}/ownership/accept`, { as: ADA, app: plain })).status).toBe(404);
  });
});

describe("a nominee discovering the offer", () => {
  beforeEach(async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
  });

  test("nothing standing reads as null rather than as a refusal", async () => {
    const response = await call("GET", `${BASE}/current/ownership`, { as: ADA });
    expect(response.status).toBe(200);
    expect((await json<{ nomination: unknown }>(response)).nomination).toBeNull();
  });

  test("the nominee can read the offer made to them, without holding `billing:manage`", async () => {
    // **The whole reason this route exists.** A nomination carries no token and sends no mail, so the
    // only way it reaches the person it was made to is a screen that reads it — and that person is by
    // definition the one who does not hold the account yet. Gating the read on `billing:manage` would
    // hide every offer from every nominee.
    const target = await membershipIdOf(ACME, BOB);
    expect((await call("POST", `${BASE}/current/ownership`, { as: ADA, body: { membershipId: target } })).status).toBe(
      201,
    );

    await chooseActing(db(), { userId: BOB, sessionId: "session_bob", organizationId: ACME, now: NOW });
    const response = await call("GET", `${BASE}/current/ownership`, { as: BOB, session: "session_bob" });
    expect(response.status).toBe(200);
    const body = await json<{ nomination: { membershipId: string; nominatedByUserId: string } | null }>(response);
    expect(body.nomination?.membershipId).toBe(target);
    expect(body.nomination?.nominatedByUserId).toBe(ADA);
  });

  test("it is still a membership gate — somebody outside the account gets the usual refusal", async () => {
    const outside = await call("GET", `${BASE}/current/ownership`, { as: CAI, session: "session_cai" });
    expect(outside.status).toBe(404);
  });

  test("a withdrawn offer reads as nothing standing", async () => {
    const target = await membershipIdOf(ACME, BOB);
    await call("POST", `${BASE}/current/ownership`, { as: ADA, body: { membershipId: target } });
    await call("DELETE", `${BASE}/current/ownership`, { as: ADA });
    const body = await json<{ nomination: unknown }>(await call("GET", `${BASE}/current/ownership`, { as: ADA }));
    expect(body.nomination).toBeNull();
  });
});

describe("marks", () => {
  test("an organization's mark is served to a member, and to nobody else", async () => {
    const served = await call("GET", `${BASE}/marks/organization/${ACME}`, { as: CAI });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");

    // Not a member. The same 404 as an account that does not exist — asserted on the rendered bytes.
    const denied = await call("GET", `${BASE}/marks/organization/${ACME}`, { as: STRANGER });
    const invented = await call("GET", `${BASE}/marks/organization/${ABSENT}`, { as: STRANGER });
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await invented.text());
  });

  test("a vector is never served by URL, however it got into the column", async () => {
    await env.DB.prepare("update pithy_organization_organizations set logo = ? where id = ?").bind(SVG, ACME).run();
    // An SVG fetched by *navigation* runs script in the origin that served it. The helper answers null
    // and this route 404s on null, so there is no arrangement of ids that makes this origin return one.
    const response = await call("GET", `${BASE}/marks/organization/${ACME}`, { as: CAI });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("svg");
  });

  test("a member's face is entitled by the roster it is drawn on", async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
    const cai = await membershipIdOf(ACME, CAI);
    const served = await call("GET", `${BASE}/members/${cai}/image`, { as: ADA });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");

    // A membership id from another account is the same 404 as one that never existed. There is no
    // arrangement of this path that asks whether a given *user* id is real.
    const foreign = await membershipIdOf(BETA, STRANGER);
    const elsewhere = await call("GET", `${BASE}/members/${foreign}/image`, { as: ADA });
    const invented = await call("GET", `${BASE}/members/${ABSENT}/image`, { as: ADA });
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).toBe(await invented.text());
  });
});

describe("founding an account", () => {
  test("the founder becomes an administrator, and the role is not in the request", async () => {
    await seedUser("user_founder");
    const response = await call("POST", BASE, {
      as: "user_founder",
      body: { name: "New Studio", slug: "new-studio", role: "owner" },
    });
    expect(response.status).toBe(201);
    const body = await json<{ organization: { id: string; role: string; slug: string } }>(response);
    // The first assignable role that administers. `owner` is excluded from assignment in this catalog,
    // so being first is not owning — ownership is accepted rather than conferred.
    expect(body.organization.role).toBe("admin");
    expect(body.organization.slug).toBe("new-studio");
    expect(actionsRecorded()).toEqual(["organization/created"]);

    // And it does not move what this session was acting in. Creating a second account from a settings
    // pane must not silently move somebody out of the one they were working in.
    expect(
      await db().selectFrom(ACTING_TABLE).select("sessionId").where("sessionId", "=", SESSION).executeTakeFirst(),
    ).toBeUndefined();
  });

  test("a taken short name refuses rather than renaming", async () => {
    await seedUser("user_founder");
    const response = await call("POST", BASE, { as: "user_founder", body: { name: "Copy", slug: "acme" } });
    expect(response.status).toBe(409);
  });

  test("with self-service off the route refuses everybody, including an administrator", async () => {
    const operated = buildApp({ config: { allowSelfService: false } });
    const response = await call("POST", BASE, {
      as: ADA,
      body: { name: "New Studio", slug: "new-studio" },
      app: operated,
    });
    expect(response.status).toBe(403);
    expect(await db().selectFrom(ORGANIZATIONS_TABLE).select("id").where("slug", "=", "new-studio").execute()).toEqual(
      [],
    );
  });
});

describe("the same-origin gate is spent on every mutating route, not merely mounted", () => {
  test("a refusing origin policy stops a fully authorized caller", async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
    const hostile = buildApp({
      sameOrigin: async () => {
        throw new ForbiddenError({ message: "Cross-origin request rejected." });
      },
    });
    // Ada holds every power there is. The gate is about where the request came from, not who sent it.
    expect((await call("PATCH", `${BASE}/current`, { as: ADA, body: { name: "Nope" }, app: hostile })).status).toBe(
      403,
    );
    expect((await call("DELETE", `${BASE}/current`, { as: ADA, app: hostile })).status).toBe(403);
    // Nothing was written.
    const row = await db().selectFrom(ORGANIZATIONS_TABLE).select("name").where("id", "=", ACME).executeTakeFirst();
    expect(row?.name).toBe("Acme Games");
  });

  test("a read is not gated by it, because a read is not a mutation", async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
    const hostile = buildApp({
      sameOrigin: async () => {
        throw new ForbiddenError({ message: "Cross-origin request rejected." });
      },
    });
    expect((await call("GET", `${BASE}/current`, { as: ADA, app: hostile })).status).toBe(200);
  });
});

describe("the management surface", () => {
  test("the account list is names and counts, and carries no addresses", async () => {
    const managed = buildApp({ verifier: verifierFor([ORGANIZATION_ACCOUNTS_READ_SCOPE]) });
    const response = await call("GET", `${BASE}/admin/organizations`, { app: managed });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("ada@example.com");
    const body = JSON.parse(raw) as { organizations: { id: string; members: number }[]; truncated: boolean };
    expect(body.organizations.map((organization) => organization.id).sort()).toEqual([ACME, BETA].sort());
    expect(body.organizations.find((organization) => organization.id === ACME)?.members).toBe(3);
    expect(body.truncated).toBe(false);
  });

  test("the roster is a second scope, and holding the first confers nothing about it", async () => {
    const accountsOnly = buildApp({ verifier: verifierFor([ORGANIZATION_ACCOUNTS_READ_SCOPE]) });
    expect((await call("GET", `${BASE}/admin/organizations/${ACME}/members`, { app: accountsOnly })).status).toBe(403);

    const both = buildApp({
      verifier: verifierFor([ORGANIZATION_ACCOUNTS_READ_SCOPE, ORGANIZATION_MEMBERS_READ_SCOPE]),
    });
    const response = await call("GET", `${BASE}/admin/organizations/${ACME}/members`, { app: both });
    expect(response.status).toBe(200);
    const body = await json<{ members: { email: string | null }[]; truncated: boolean }>(response);
    expect(body.members.map((member) => member.email)).toEqual([
      "ada@example.com",
      "bob@example.com",
      "cai@example.com",
    ]);
    expect(body.truncated).toBe(false);
  });

  test("a bounded listing says when it cut itself short", async () => {
    const managed = buildApp({
      verifier: verifierFor([ORGANIZATION_ACCOUNTS_READ_SCOPE, ORGANIZATION_MEMBERS_READ_SCOPE]),
    });
    const body = await json<{ members: unknown[]; truncated: boolean }>(
      await call("GET", `${BASE}/admin/organizations/${ACME}/members?limit=2`, { app: managed }),
    );
    // A client must say so rather than imply a total.
    expect(body.members).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });

  test("a member's own session cannot reach it, whatever they hold", async () => {
    await chooseActing(db(), { userId: ADA, sessionId: SESSION, organizationId: ACME, now: NOW });
    // No control-plane verifier composed, which is the state every ordinary Worker is in.
    expect((await call("GET", `${BASE}/admin/organizations`, { as: ADA })).status).toBe(403);
  });
});
