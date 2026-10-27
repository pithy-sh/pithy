// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AuditConfig, audit } from "../capability";
import { type AuditDatabase, auditDatabase } from "../data/tables";
import { audit_0001_init } from "../migrations/0001_init";
import { audit_0002_actor_kind } from "../migrations/0002_actor_kind";
import { audit_0003_call_index } from "../migrations/0003_call_index";
import { audit_0004_request_index } from "../migrations/0004_request_index";
import { queryAuditEvents } from "../query";
import { recordAuditEvent } from "../recorder";
import { AUDIT_EVENT_DETAIL_READ_SCOPE, AUDIT_TRAIL_READ_SCOPE, auditAdminRoutes } from "./guards";
import {
  AccessHistoryResponse,
  AuditEventResponse,
  AuditEventsResponse,
  ControlPlaneReachResponse,
  ControlPlaneUsageResponse,
} from "./responses";
import { registerAuditRoutes } from "./routes";

/**
 * The control-plane handlers, actually executed.
 *
 * `routeContract.test.ts` calls each route with no credential and asserts 403, which proves the guard
 * runs and nothing else — every handler body is unreached there. What lives only here: the projection
 * that decides which columns a management client may see, the keyset pagination that decides whether a
 * client paging a live trail can silently miss a record, and the audit write that records the read.
 * Each of those could be deleted with that file still green.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const BASE = AuditConfig.parse({}).basePath;
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "agent",
    purpose: "Incident review.",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

/**
 * The app, with a live control-plane verifier and a capturing `emit`.
 *
 * `emit` captures rather than writing, so the assertions about *what a read discloses* are not fighting
 * the rows the read itself appends. That the seam reaches D1 at all is proven in
 * `capability.workers.test.ts`, through the real composition.
 */
function harness(scopes: readonly ControlPlaneScope[]) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    c.set("db", { app: auditDatabase(env.DB) } as never);
    await next();
  });
  return app;
}

/** The admin routes a reach read groups by, beyond audit's own: one capability's user routes. */
const USER_ROUTES: AdminRoute[] = [
  { method: "GET", path: "/admin/users/:userId", scope: "auth:users:read", summary: "Read one user." },
];

function makeApp(
  scopes: readonly ControlPlaneScope[],
  basePath = BASE,
  database: () => AuditDatabase = () => auditDatabase(env.DB),
) {
  const app = harness(scopes);
  registerAuditRoutes({
    basePath,
    database,
    adminRoutes: () => [...auditAdminRoutes(basePath), ...USER_ROUTES],
  })(app);
  return app;
}

/** A request carrying a freshly minted control-plane token. */
async function call(
  app: Hono<PithyHonoEnv>,
  path: string,
  scope: ControlPlaneScope,
  method = "GET",
): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method, headers: { [CONTROL_PLANE_HEADER]: token } },
    { ...env, ENVIRONMENT },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

/** Seed one event through the real recorder, so every column is written the way production writes it. */
async function seed(event: AuditEventInput, occurredAt: Date): Promise<void> {
  await recordAuditEvent(
    auditDatabase(env.DB) as AuditDatabase,
    { ...event, occurredAt },
    { origin: { project: "acme", environment: ENVIRONMENT, worker: "api", version: "build-7" } },
  );
}

/** Every seeded event, newest first, as the trail itself orders them. */
async function trail() {
  return queryAuditEvents(auditDatabase(env.DB));
}

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  await audit_0001_init.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
  await audit_0002_actor_kind.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
  await audit_0003_call_index.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
  await audit_0004_request_index.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
  emitted = [];
});

describe("GET /audit/events", () => {
  test("returns the trail newest first, with the build that recorded each event", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(1_000));
    await seed({ action: "auth/logout", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(2_000));

    const response = await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE);
    expect(response.status).toBe(200);
    const body = await response.json<{ events: { action: string; version: string | null }[]; nextCursor: null }>();
    expect(body.events.map((e) => e.action)).toEqual(["auth/logout", "auth/login"]);
    // The point of the version column: which build recorded it, not merely that something did.
    expect(body.events[0]?.version).toBe("build-7");
    expect(body.nextCursor).toBeNull();
  });

  test("never discloses the IP, the user-agent, or the metadata bag", async () => {
    // The whole reason the detail read is a separate scope. A listing that leaked any of these would
    // make that grant decorative, and this is the assertion that keeps the projection deliberate — a
    // `SELECT *` handed straight to `c.json` passes every other test in this file.
    await seed(
      {
        action: "testers/member_invited",
        outcome: "success",
        actorType: "control-plane",
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { email: "ada@example.test" },
      },
      new Date(3_000),
    );

    const body = await (await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE)).text();
    expect(body).not.toContain("203.0.113.9");
    expect(body).not.toContain("Dashboard/1.0");
    expect(body).not.toContain("ada@example.test");
    expect(body).toContain("testers/member_invited");
  });

  test("never discloses the internal autoincrement id", async () => {
    // Its own schema says internal, never exposed: it is monotonic, so publishing it tells a client
    // how many events the project has recorded. The cursor carries it as an opaque position, which is
    // a different thing from offering it as a field.
    await seed({ action: "auth/login", outcome: "success", actorType: "user" }, new Date(1_000));
    const body = await (await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: Record<string, unknown>[];
    }>();
    expect(body.events[0]).toBeDefined();
    expect(Object.keys(body.events[0] ?? {})).not.toContain("id");
  });

  test("filters by actor, action, and time range", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(1_000));
    await seed({ action: "auth/login", outcome: "denied", actorType: "user", actorId: "u-2" }, new Date(2_000));
    await seed({ action: "secrets/rotated", outcome: "success", actorType: "system" }, new Date(3_000));

    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const byActor = await (await call(app, `${BASE}/events?actorId=u-2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
    }>();
    expect(byActor.events.map((e) => e.actorId)).toEqual(["u-2"]);

    const byOutcome = await (await call(app, `${BASE}/events?outcome=denied`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { action: string }[];
    }>();
    expect(byOutcome.events).toHaveLength(1);

    const window = new Date(2_000).toISOString();
    const byTime = await (await call(app, `${BASE}/events?from=${window}&to=${window}`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
    }>();
    expect(byTime.events.map((e) => e.actorId)).toEqual(["u-2"]);
  });

  test("filters by tenant, and by no tenant at all", async () => {
    // The pane this route exists for draws one customer's history. `?tenant=` — the parameter present
    // and empty — is the null filter: an empty string is not a legal tenant id, so it can never collide
    // with one, and the question "what was done outside any customer's account" stays askable over HTTP
    // instead of only from Kysely.
    await seed(
      { action: "admin/config_changed", outcome: "success", actorType: "user", actorId: "ada", tenant: "org-a" },
      new Date(1_000),
    );
    await seed(
      { action: "admin/config_changed", outcome: "success", actorType: "user", actorId: "ada", tenant: "org-b" },
      new Date(2_000),
    );
    await seed({ action: "secrets/rotated", outcome: "success", actorType: "system" }, new Date(3_000));

    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const byTenant = await (await call(app, `${BASE}/events?tenant=org-a`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { tenant: string | null; actorId: string }[];
    }>();
    expect(byTenant.events.map((e) => e.tenant)).toEqual(["org-a"]);

    const untenanted = await (await call(app, `${BASE}/events?tenant=`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { tenant: string | null; action: string }[];
    }>();
    expect(untenanted.events.map((e) => e.action)).toEqual(["secrets/rotated"]);
    expect(untenanted.events.map((e) => e.tenant)).toEqual([null]);

    // And absent means unfiltered — the three events, not the untenanted one.
    const all = await (await call(app, `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE)).json<{ events: unknown[] }>();
    expect(all.events).toHaveLength(3);
  });

  test("refuses a page larger than the shared ceiling, and a bound that is not a time", async () => {
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    expect((await call(app, `${BASE}/events?limit=1000`, AUDIT_TRAIL_READ_SCOPE)).status).toBe(400);
    const bad = await call(app, `${BASE}/events?from=yesterday`, AUDIT_TRAIL_READ_SCOPE);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("validation/invalid_input");
  });

  test("audits the read, with what was asked for and how much came back", async () => {
    // Reading the record of everybody else's actions is itself one. Core's guard records that the call
    // was allowed; only the handler knows the filter and the size of the answer, which is the
    // difference between "somebody opened a pane" and "something paged the whole trail".
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(1_000));
    await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events?actorId=u-1`, AUDIT_TRAIL_READ_SCOPE);

    const read = emitted.find((event) => event.action === "audit/trail_read");
    expect(read?.actorType).toBe("control-plane");
    expect(read?.actorId).toBe("operator-1");
    // Which kind of client read the trail, from the connection it called through — stamped by the gate,
    // not by this handler (#721).
    expect(read?.actorKind).toBe("agent");
    const metadata = read?.metadata as { connectionId: string; returned: number; query: { actorId?: string } };
    expect(metadata.connectionId).toBe(CONNECTION_ID);
    expect(metadata.returned).toBe(1);
    expect(metadata.query.actorId).toBe("u-1");
  });
});

describe("paging a trail that is still being written", () => {
  /** Five events, one millisecond apart, newest last. */
  async function fiveEvents() {
    for (let index = 0; index < 5; index += 1) {
      await seed(
        { action: "auth/login", outcome: "success", actorType: "user", actorId: `u-${index}` },
        new Date(index),
      );
    }
  }

  test("a cursor resumes exactly where the previous page ended", async () => {
    await fiveEvents();
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);

    const first = await (await call(app, `${BASE}/events?limit=2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
      nextCursor: string;
    }>();
    expect(first.events.map((e) => e.actorId)).toEqual(["u-4", "u-3"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[]; nextCursor: string }>();
    expect(second.events.map((e) => e.actorId)).toEqual(["u-2", "u-1"]);

    const third = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[]; nextCursor: string | null }>();
    expect(third.events.map((e) => e.actorId)).toEqual(["u-0"]);
    // Null without a count query — the over-fetched row is what answers "is there more".
    expect(third.nextCursor).toBeNull();
  });

  test("an event written mid-read is not a skipped record", async () => {
    // The failure `OFFSET` has and keyset does not. With `OFFSET 2`, a row inserted at the head between
    // the two requests pushes `u-2` off page one and onto page two, so the client sees `u-3` twice and
    // reads `u-2` never. On an audit trail that is a record silently missed, not a cosmetic glitch.
    await fiveEvents();
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);

    const first = await (await call(app, `${BASE}/events?limit=2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
      nextCursor: string;
    }>();
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-new" }, new Date(99));

    const second = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[] }>();
    const seen = [...first.events, ...second.events].map((e) => e.actorId);
    expect(seen).toEqual(["u-4", "u-3", "u-2", "u-1"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("two events recorded in the same millisecond both survive a page boundary", async () => {
    // The reason the cursor carries an id at all. Sorting on the timestamp alone leaves two rows sharing
    // an instant straddling the boundary, and one of them is dropped or repeated.
    for (const actor of ["a", "b", "c"]) {
      await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: actor }, new Date(5_000));
    }
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const first = await (await call(app, `${BASE}/events?limit=2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
      nextCursor: string;
    }>();
    const second = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[] }>();
    const seen = [...first.events, ...second.events].map((e) => e.actorId);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  test("a malformed cursor is a first page, not a 500", async () => {
    // Cursors travel through URLs, get truncated by clients, and outlive deploys. Treating a bad one as
    // an error turns an ordinary client bug into a pane that never loads, and hands anyone probing the
    // endpoint a way to tell a parse failure from an empty result.
    await fiveEvents();
    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      `${BASE}/events?limit=2&cursor=not-a-cursor`,
      AUDIT_TRAIL_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ events: { actorId: string }[] }>();
    expect(body.events.map((e) => e.actorId)).toEqual(["u-4", "u-3"]);
  });
});

describe("GET /audit/events/:eventId", () => {
  test("returns the one event in full — IP, user-agent, and metadata included", async () => {
    await seed(
      {
        action: "auth/login",
        outcome: "success",
        actorType: "user",
        actorId: "u-1",
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { reason: "magic_link" },
      },
      new Date(1_000),
    );
    const [event] = await trail();
    expect(event).toBeDefined();

    const response = await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events/${event?.eventId}`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      event: { ip: string; userAgent: string; metadata: { reason: string }; version: string };
    }>();
    expect(body.event.ip).toBe("203.0.113.9");
    expect(body.event.userAgent).toBe("Dashboard/1.0");
    expect(body.event.metadata.reason).toBe("magic_link");
    expect(body.event.version).toBe("build-7");
  });

  test("an id nobody recorded is a 404, and the miss is still audited", async () => {
    // Probing for ids must not be the one action on this surface that leaves no trace.
    const missing = "11111111-2222-4333-8444-555555555555";
    const response = await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events/${missing}`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("core/not_found");
    const read = emitted.find((event) => event.action === "audit/event_read");
    expect(read?.outcome).toBe("failure");
    expect(read?.resourceId).toBe(missing);
  });

  test("audits which event was read, by whom", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user" }, new Date(1_000));
    const [event] = await trail();
    await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events/${event?.eventId}`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    const read = emitted.find((entry) => entry.action === "audit/event_read");
    expect(read?.resourceId).toBe(event?.eventId);
    expect(read?.actorId).toBe("operator-1");
    expect(read?.outcome).toBe("success");
  });
});

describe("GET /audit/control-plane/reach", () => {
  const REACH = `${BASE}/control-plane/reach?connectionId=${CONNECTION_ID}&since=1970-01-01T00:00:00.000Z`;

  /** An admitted call to a user route, as the gate records it, and the event its handler recorded beside it. */
  async function userRead(userId: string, tenant: string, at: number, keyId = CONTROL_PLANE_KEY_ID): Promise<void> {
    const requestId = `ray-${userId}-${at}`;
    await seed(
      {
        action: "controlplane/call_allowed",
        outcome: "success",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceType: "controlplane_connection",
        resourceId: CONNECTION_ID,
        requestId,
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: {
          connectionId: CONNECTION_ID,
          connectionEnvironment: ENVIRONMENT,
          scope: "auth:users:read",
          keyId,
          method: "GET",
          path: `/admin/users/${userId}`,
        },
      },
      new Date(at),
    );
    await seed(
      {
        action: "auth/user_read",
        outcome: "success",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceType: "user",
        resourceId: userId,
        requestId,
        tenant,
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { email: "ada@example.test" },
      },
      new Date(at),
    );
  }

  test("answers what the credential reached, by tenant and declared route", async () => {
    await userRead("u_1", "acme", 1_000);
    await userRead("u_2", "acme", 2_000);
    await userRead("u_9", "globex", 3_000);

    const response = await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), REACH, AUDIT_TRAIL_READ_SCOPE);

    expect(response.status).toBe(200);
    const body = await response.json<ControlPlaneReachResponse>();
    expect(body.connectionId).toBe(CONNECTION_ID);
    expect(body.keyId).toBeNull();
    // `until` defaults to the wall clock at the read, not to any fixture's instant.
    expect(Math.abs(Date.parse(body.until) - Date.now())).toBeLessThan(60_000);
    expect(body.subjects).toBeUndefined();
    expect(body.reach.map((row) => [row.tenant, row.route, row.matched, row.count, row.subjects])).toEqual([
      ["acme", "/admin/users/:userId", true, 2, 2],
      ["globex", "/admin/users/:userId", true, 1, 1],
    ]);
  });

  test("subjects=true expands a route into the subject ids its called paths name", async () => {
    await userRead("u_1", "acme", 1_000);
    await userRead("u_2", "acme", 2_000);

    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      `${REACH}&route=${encodeURIComponent("/admin/users/:userId")}&subjects=true`,
      AUDIT_TRAIL_READ_SCOPE,
    );

    expect(response.status).toBe(200);
    const body = await response.json<ControlPlaneReachResponse>();
    expect(body.subjects?.map((row) => [row.tenant, row.subjectId, row.params, row.count])).toEqual([
      ["acme", "u_1", { userId: "u_1" }, 1],
      ["acme", "u_2", { userId: "u_2" }, 1],
    ]);
    expect(body.reach.map((row) => [row.route, row.subjects])).toEqual([["/admin/users/:userId", 2]]);
  });

  test("keyId and until narrow the read", async () => {
    await userRead("u_1", "acme", 1_000);
    await userRead("u_2", "acme", 2_000, "key-2");
    await userRead("u_3", "acme", 5_000);

    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const byKey = await (
      await call(app, `${REACH}&keyId=key-2`, AUDIT_TRAIL_READ_SCOPE)
    ).json<ControlPlaneReachResponse>();
    const byTime = await (
      await call(app, `${REACH}&until=1970-01-01T00:00:03.000Z`, AUDIT_TRAIL_READ_SCOPE)
    ).json<ControlPlaneReachResponse>();

    expect(byKey.keyId).toBe("key-2");
    expect(byKey.reach.map((row) => row.count)).toEqual([1]);
    expect(byTime.reach.map((row) => row.count)).toEqual([2]);
  });

  test("connectionId and since are required, a window cannot end before it starts, and subjects needs a route", async () => {
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const bad = [
      `${BASE}/control-plane/reach?since=1970-01-01T00:00:00.000Z`,
      `${BASE}/control-plane/reach?connectionId=${CONNECTION_ID}`,
      `${REACH}&until=1969-12-31T00:00:00.000Z`,
      `${REACH}&subjects=true`,
      `${REACH}&route=admin/users`,
    ];
    for (const path of bad) {
      const response = await call(app, path, AUDIT_TRAIL_READ_SCOPE);
      expect(response.status, path).toBe(400);
      expect(await errorCode(response), path).toBe("validation/invalid_input");
    }
  });

  test("refuses a connection without the listing scope, the detail scope included", async () => {
    for (const scopes of [[], [AUDIT_EVENT_DETAIL_READ_SCOPE]]) {
      const response = await call(makeApp(scopes), REACH, AUDIT_TRAIL_READ_SCOPE);
      expect(response.status).toBe(403);
    }
    const detail = await call(makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]), REACH, AUDIT_EVENT_DETAIL_READ_SCOPE);
    expect(detail.status).toBe(403);
  });

  test("never discloses the IP, the user-agent, or any metadata key beyond the route and scope", async () => {
    await userRead("u_1", "acme", 1_000);
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const bodies = [
      await (await call(app, REACH, AUDIT_TRAIL_READ_SCOPE)).text(),
      await (
        await call(
          app,
          `${REACH}&route=${encodeURIComponent("/admin/users/:userId")}&subjects=true`,
          AUDIT_TRAIL_READ_SCOPE,
        )
      ).text(),
    ];
    for (const body of bodies) {
      for (const leaked of ["203.0.113.9", "Dashboard/1.0", "ada@example.test", ENVIRONMENT, "operator-1"]) {
        expect(body, leaked).not.toContain(leaked);
      }
    }
  });

  test("audits the read against the connection whose reach was read", async () => {
    await userRead("u_1", "acme", 1_000);
    await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      `${REACH}&route=${encodeURIComponent("/admin/users/:userId")}&subjects=true`,
      AUDIT_TRAIL_READ_SCOPE,
    );

    const read = emitted.find((event) => event.action === "audit/reach_read");
    expect(read).toMatchObject({
      outcome: "success",
      actorType: "control-plane",
      actorId: "operator-1",
      actorKind: "agent",
      resourceType: "controlplane_connection",
      resourceId: CONNECTION_ID,
    });
    expect(read?.metadata).toEqual({
      connectionId: CONNECTION_ID,
      query: {
        connectionId: CONNECTION_ID,
        keyId: null,
        since: "1970-01-01T00:00:00.000Z",
        until: expect.any(String),
        route: "/admin/users/:userId",
        subjects: true,
      },
      returned: 1,
      subjects: 1,
    });
  });

  test("groups by every composed capability's routes, which the capability gathers at compose", async () => {
    // Through the capability itself rather than `registerAuditRoutes`: the routes it groups by are the ones
    // `compose` handed it, so a capability declaring a route audit has never heard of still gets its paths matched.
    await userRead("u_1", "acme", 1_000);
    const reachOf = async (capability: ReturnType<typeof audit>) => {
      const app = harness([AUDIT_TRAIL_READ_SCOPE]);
      capability.routes?.(app);
      const body = await (await call(app, REACH, AUDIT_TRAIL_READ_SCOPE)).json<ControlPlaneReachResponse>();
      return body.reach.map((row) => [row.route, row.matched]);
    };

    const alone = audit();
    expect(await reachOf(alone)).toEqual([["/admin/users/u_1", false]]);

    const composed = audit();
    const users = { name: "auth", requiredBindings: [], adminRoutes: USER_ROUTES } as unknown as Capability;
    composed.compose?.({ capabilities: [composed, users] });
    expect(await reachOf(composed)).toEqual([["/admin/users/:userId", true]]);
  });
});

describe("the two read scopes are not interchangeable", () => {
  test("a listing credential cannot read one event in full", async () => {
    // The split is the whole control: a credential issued to render a recent-activity pane must not
    // also resolve every client IP and metadata bag in the project.
    await seed({ action: "auth/login", outcome: "success", actorType: "user", ip: "203.0.113.9" }, new Date(1_000));
    const [event] = await trail();
    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      `${BASE}/events/${event?.eventId}`,
      AUDIT_TRAIL_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("a detail credential cannot enumerate the trail", async () => {
    // The reverse, and it is what stops the detail scope from being a bulk-harvest grant: holding it
    // alone, there is no route that hands out the ids to resolve.
    const response = await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("a connection granted neither reads nothing", async () => {
    const response = await call(makeApp([]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE);
    expect(response.status).toBe(403);
  });
});

describe("the exported response schemas against the live routes", () => {
  /**
   * The binding between what a route returns and what a client is told it returns.
   *
   * Parsing alone is not enough: a Zod object strips unknown keys, so a route that grew a field would
   * still parse. Comparing the parsed value with the raw body fails in both directions — a field the
   * schema does not know about is dropped and shows as a difference, a field it declares wrongly fails
   * the parse. That is what makes the two unable to drift silently.
   */
  test("GET /events returns exactly AuditEventsResponse", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(1_000));
    await seed(
      {
        action: "testers/member_invited",
        outcome: "denied",
        severity: "warning",
        actorType: "control-plane",
        actorId: "ops@dashboard.test",
        sessionId: "s-1",
        resourceType: "testers_member",
        resourceId: "m-1",
        requestId: "cf-ray-1",
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { email: "ada@example.test" },
      },
      new Date(2_000),
    );

    const body = await (
      await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events?limit=1`, AUDIT_TRAIL_READ_SCOPE)
    ).json();
    expect(AuditEventsResponse.parse(body)).toEqual(body);
    // A page that stops short must still carry a cursor, or the schema is only proven on the last page.
    expect((body as AuditEventsResponse).nextCursor).not.toBeNull();
  });

  test("GET /events/:eventId returns exactly AuditEventResponse", async () => {
    await seed(
      {
        action: "auth/login",
        outcome: "success",
        actorType: "user",
        actorId: "u-1",
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { reason: "magic_link" },
      },
      new Date(1_000),
    );
    const [event] = await trail();
    const body = await (
      await call(
        makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
        `${BASE}/events/${event?.eventId}`,
        AUDIT_EVENT_DETAIL_READ_SCOPE,
      )
    ).json();
    expect(AuditEventResponse.parse(body)).toEqual(body);
  });

  test("GET /control-plane/reach returns exactly ControlPlaneReachResponse, with and without subjects", async () => {
    await seed(
      {
        action: "controlplane/call_allowed",
        outcome: "success",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceType: "controlplane_connection",
        resourceId: CONNECTION_ID,
        requestId: "ray-1",
        metadata: { scope: "auth:users:read", keyId: CONTROL_PLANE_KEY_ID, method: "GET", path: "/admin/users/u_1" },
      },
      new Date(1_000),
    );
    const base = `${BASE}/control-plane/reach?connectionId=${CONNECTION_ID}&since=1970-01-01T00:00:00.000Z`;
    for (const path of [base, `${base}&route=${encodeURIComponent("/admin/users/:userId")}&subjects=true`]) {
      const body = await (await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), path, AUDIT_TRAIL_READ_SCOPE)).json();
      expect(ControlPlaneReachResponse.parse(body), path).toEqual(body);
      expect((body as ControlPlaneReachResponse).reach, path).toHaveLength(1);
    }
  });
});

describe("GET /audit/control-plane/access-history (#831)", () => {
  const PATH = `${BASE}/control-plane/access-history`;
  const WINDOW = `since=${new Date(0).toISOString()}&until=${NOW.toISOString()}`;

  /** A member's role change, a connection's registration and a key's, each as its emitter writes it. */
  async function seedChanges(): Promise<void> {
    await seed(
      {
        action: "organization/member_role_changed",
        outcome: "success",
        actorType: "user",
        actorId: "user_ada",
        tenant: "org-42",
        resourceType: "membership",
        resourceId: "mem_bob",
        sessionId: "session_1",
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { role: "member", previousRole: "admin", subjectUserId: "user_bob" },
      },
      new Date(1_000),
    );
    await seed(
      {
        action: "controlplane/connection_registered",
        outcome: "success",
        severity: "warning",
        actorType: "user",
        actorId: "cf:ada@example.com",
        resourceType: "controlplane_connection",
        resourceId: CONNECTION_ID,
        metadata: {
          connectionId: CONNECTION_ID,
          workerUrl: "https://hidden-worker.example",
          scopes: ["audit:events:read"],
          authorizedBy: "ada@example.com",
          actorKind: "agent",
          purpose: "Incident review.",
        },
      },
      new Date(2_000),
    );
    await seed(
      {
        action: "controlplane/key_registered",
        outcome: "success",
        severity: "warning",
        actorType: "control-plane",
        actorId: "operator-1",
        actorKind: "agent",
        resourceType: "controlplane_connection",
        resourceId: CONNECTION_ID,
        metadata: { connectionId: CONNECTION_ID, registeredKeyId: "key-2", signedWithKeyId: "key-1" },
      },
      new Date(3_000),
    );
  }

  test("answers every member, connection and key change in the window, oldest first, exactly as declared", async () => {
    await seedChanges();
    const response = await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${PATH}?${WINDOW}`, AUDIT_TRAIL_READ_SCOPE);
    expect(response.status).toBe(200);
    const body = await response.json<AccessHistoryResponse>();
    expect(AccessHistoryResponse.parse(body)).toEqual(body);

    expect(body.since).toBe(new Date(0).toISOString());
    expect(body.until).toBe(NOW.toISOString());
    expect(body.nextCursor).toBeNull();
    expect(body.changes.map((change) => change.subject)).toEqual(["member", "connection", "key"]);
    const [member, registered, key] = body.changes;
    expect(member).toMatchObject({
      action: "organization/member_role_changed",
      occurredAt: new Date(1_000).toISOString(),
      actorType: "user",
      actorId: "user_ada",
      organizationId: "org-42",
      membershipId: "mem_bob",
      userId: "user_bob",
      roleBefore: "admin",
      roleAfter: "member",
      detail: "recorded",
    });
    expect(registered).toMatchObject({
      connectionId: CONNECTION_ID,
      connectionKind: "agent",
      purpose: "Incident review.",
      principal: "ada@example.com",
      scopesBefore: null,
      scopesAfter: ["audit:events:read"],
      detail: "recorded",
    });
    expect(key).toMatchObject({
      connectionId: CONNECTION_ID,
      keyId: "key-2",
      change: "registered",
      actorKind: "agent",
    });
  });

  test("never discloses an IP, a user-agent, or another metadata key", async () => {
    await seedChanges();
    const text = await (
      await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${PATH}?${WINDOW}`, AUDIT_TRAIL_READ_SCOPE)
    ).text();
    for (const leaked of ["203.0.113.9", "Dashboard/1.0", "session_1", "hidden-worker", "key-1"]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  test("an older change without its before and after says so", async () => {
    await seed(
      {
        action: "organization/member_role_changed",
        outcome: "success",
        actorType: "user",
        actorId: "user_ada",
        tenant: "org-42",
        resourceType: "membership",
        resourceId: "mem_bob",
        metadata: { role: "member", subjectUserId: "user_bob" },
      },
      new Date(1_000),
    );
    const body = await (
      await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${PATH}?${WINDOW}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<AccessHistoryResponse>();
    expect(body.changes[0]).toMatchObject({ roleBefore: null, roleAfter: "member", detail: "not_recorded" });
  });

  test("pages with a cursor, and the window ends now when it names no end", async () => {
    await seedChanges();
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const since = `since=${new Date(0).toISOString()}`;
    const first = await (
      await call(app, `${PATH}?${since}&limit=2`, AUDIT_TRAIL_READ_SCOPE)
    ).json<AccessHistoryResponse>();
    // The handler's own clock: a window with no end is everything up to the moment it was read.
    expect(Math.abs(Date.parse(first.until) - Date.now())).toBeLessThan(60_000);
    expect(first.changes).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await (
      await call(app, `${PATH}?${since}&limit=2&cursor=${first.nextCursor}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<AccessHistoryResponse>();
    expect(second.changes.map((change) => change.subject)).toEqual(["key"]);
    expect(second.nextCursor).toBeNull();
  });

  test("refuses a connection without audit:events:read, even one holding the detail scope", async () => {
    const response = await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${PATH}?${WINDOW}`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    expect(response.status).toBe(403);
    expect(emitted.some((event) => event.action === "audit/access_history_read")).toBe(false);
  });

  test("refuses a missing start, and a window that ends before it begins, before any query runs", async () => {
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const missing = await call(app, PATH, AUDIT_TRAIL_READ_SCOPE);
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe("validation/invalid_input");
    const backwards = await call(
      app,
      `${PATH}?since=${NOW.toISOString()}&until=${new Date(0).toISOString()}`,
      AUDIT_TRAIL_READ_SCOPE,
    );
    expect(backwards.status).toBe(400);
  });

  test("audits the read, with the window asked for and how much came back", async () => {
    await seedChanges();
    await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${PATH}?${WINDOW}`, AUDIT_TRAIL_READ_SCOPE);
    const read = emitted.find((event) => event.action === "audit/access_history_read");
    expect(read).toMatchObject({
      outcome: "success",
      actorType: "control-plane",
      actorId: "operator-1",
      resourceType: "audit_trail",
    });
    expect(read?.metadata).toEqual({
      connectionId: CONNECTION_ID,
      query: { since: new Date(0).toISOString(), until: NOW.toISOString(), resumed: false },
      returned: 3,
      more: false,
    });
  });
});

describe("GET /audit/control-plane/usage (#812)", () => {
  const USAGE = `${BASE}/control-plane/usage`;
  const TARGET = "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

  /** An admitted call by the target connection, carrying everything the gate records — IP and user-agent included. */
  function callAllowed(scope: string, path: string): AuditEventInput {
    return {
      action: "controlplane/call_allowed",
      outcome: "success",
      actorType: "control-plane",
      actorId: "usr_ops",
      resourceType: "controlplane_connection",
      resourceId: TARGET,
      ip: "203.0.113.9",
      userAgent: "Dashboard/1.0",
      metadata: {
        connectionId: TARGET,
        connectionEnvironment: "prod-secret-env",
        scope,
        keyId: "key-target",
        method: "GET",
        path,
        email: "ada@example.test",
      },
    };
  }

  function callDenied(required: string): AuditEventInput {
    return {
      action: "controlplane/call_denied",
      outcome: "denied",
      severity: "warning",
      actorType: "control-plane",
      actorId: "usr_ops",
      resourceType: "controlplane_connection",
      resourceId: TARGET,
      ip: "203.0.113.9",
      userAgent: "Dashboard/1.0",
      metadata: {
        reason: "controlplane/insufficient_scope",
        required,
        method: "POST",
        path: "/x",
        keyId: "key-target",
      },
    };
  }

  const query = (params: Record<string, string>) => `${USAGE}?${new URLSearchParams(params).toString()}`;

  test("answers one row per scope and key, with the trail's reach beside them", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(500));
    await seed(callAllowed("audit:events:read", "/audit/events"), new Date(1_000));
    await seed(callAllowed("audit:events:read", "/audit/events?limit=5"), new Date(2_000));
    await seed(callDenied("payments:overrides:set"), new Date(3_000));

    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      query({ connectionId: TARGET, since: "1970-01-01T00:00:00.000Z", until: "1970-01-01T01:00:00.000Z" }),
      AUDIT_TRAIL_READ_SCOPE,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connectionId: TARGET,
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T01:00:00.000Z",
      oldestEventAt: "1970-01-01T00:00:00.500Z",
      usage: [
        {
          scope: "audit:events:read",
          keyId: "key-target",
          allowed: 2,
          denied: 0,
          lastAllowedAt: "1970-01-01T00:00:02.000Z",
          lastAllowedMethod: "GET",
          lastAllowedPath: "/audit/events?limit=5",
          lastDeniedAt: null,
        },
        {
          scope: "payments:overrides:set",
          keyId: "key-target",
          allowed: 0,
          denied: 1,
          lastAllowedAt: null,
          lastAllowedMethod: null,
          lastAllowedPath: null,
          lastDeniedAt: "1970-01-01T00:00:03.000Z",
        },
      ],
    });
  });

  test("carries no IP, no user-agent, and no metadata key beyond scope, key, method and path", async () => {
    await seed(callAllowed("audit:events:read", "/audit/events"), new Date(1_000));

    const body = await (
      await call(
        makeApp([AUDIT_TRAIL_READ_SCOPE]),
        query({ connectionId: TARGET, since: "1970-01-01T00:00:00.000Z" }),
        AUDIT_TRAIL_READ_SCOPE,
      )
    ).text();

    expect(body).not.toContain("203.0.113.9");
    expect(body).not.toContain("Dashboard/1.0");
    expect(body).not.toContain("ada@example.test");
    expect(body).not.toContain("prod-secret-env");
    expect(body).not.toContain("usr_ops");
    const [row] = (JSON.parse(body) as { usage: Record<string, unknown>[] }).usage;
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "allowed",
      "denied",
      "keyId",
      "lastAllowedAt",
      "lastAllowedMethod",
      "lastAllowedPath",
      "lastDeniedAt",
      "scope",
    ]);
  });

  test("until defaults to now", async () => {
    await seed(callAllowed("audit:events:read", "/audit/events"), new Date(Date.now() - 1_000));
    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      query({ connectionId: TARGET, since: "1970-01-01T00:00:00.000Z" }),
      AUDIT_TRAIL_READ_SCOPE,
    );
    const body = await response.json<{ until: string; usage: { allowed: number }[] }>();
    expect(body.usage[0]?.allowed).toBe(1);
    expect(Math.abs(Date.parse(body.until) - Date.now())).toBeLessThan(60_000);
  });

  test("oldestEventAt is null on an empty trail", async () => {
    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      query({ connectionId: TARGET, since: "1970-01-01T00:00:00.000Z" }),
      AUDIT_TRAIL_READ_SCOPE,
    );
    expect(await response.json()).toMatchObject({ usage: [], oldestEventAt: null });
  });

  test("a missing connectionId or since, or a window that ends before it starts, is refused before any query", async () => {
    let queried = 0;
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE], BASE, () => {
      queried += 1;
      return auditDatabase(env.DB);
    });
    const refused: Record<string, string>[] = [
      { since: "1970-01-01T00:00:00.000Z" },
      { connectionId: TARGET },
      { connectionId: TARGET, since: "yesterday" },
      { connectionId: TARGET, since: "1970-01-02T00:00:00.000Z", until: "1970-01-01T00:00:00.000Z" },
    ];
    for (const params of refused) {
      const response = await call(app, query(params), AUDIT_TRAIL_READ_SCOPE);
      expect(response.status, JSON.stringify(params)).toBe(400);
      expect(await errorCode(response)).toBe("validation/invalid_input");
    }
    expect(queried).toBe(0);
  });

  test("needs audit:events:read, and the detail scope does not stand in for it", async () => {
    const params = query({ connectionId: TARGET, since: "1970-01-01T00:00:00.000Z" });
    const ungranted = await call(makeApp([]), params, AUDIT_TRAIL_READ_SCOPE);
    expect(ungranted.status).toBe(403);
    expect(await errorCode(ungranted)).toBe("controlplane/insufficient_scope");
    const detailOnly = await call(makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]), params, AUDIT_EVENT_DETAIL_READ_SCOPE);
    expect(detailOnly.status).toBe(403);
  });

  test("audits the read: whose usage was asked for, over what window, and how many rows came back", async () => {
    await seed(callAllowed("audit:events:read", "/audit/events"), new Date(1_000));
    await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      query({ connectionId: TARGET, since: "1970-01-01T00:00:00.000Z", until: "1970-01-01T01:00:00.000Z" }),
      AUDIT_TRAIL_READ_SCOPE,
    );
    const read = emitted.find((event) => event.action === "audit/usage_read");
    expect(read).toMatchObject({
      outcome: "success",
      actorType: "control-plane",
      actorId: "operator-1",
      resourceType: "controlplane_connection",
      resourceId: TARGET,
      metadata: {
        connectionId: CONNECTION_ID,
        query: { connectionId: TARGET, since: "1970-01-01T00:00:00.000Z", until: "1970-01-01T01:00:00.000Z" },
        returned: 1,
      },
    });
  });

  test("returns exactly ControlPlaneUsageResponse", async () => {
    await seed(callAllowed("audit:events:read", "/audit/events"), new Date(1_000));
    await seed(callDenied("payments:overrides:set"), new Date(2_000));
    const body = await (
      await call(
        makeApp([AUDIT_TRAIL_READ_SCOPE]),
        query({ connectionId: TARGET, since: "1970-01-01T00:00:00.000Z" }),
        AUDIT_TRAIL_READ_SCOPE,
      )
    ).json();
    expect(ControlPlaneUsageResponse.parse(body)).toEqual(body);
  });
});
