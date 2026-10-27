// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { type AuditDatabase, auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { audit_0002_actor_kind } from "./migrations/0002_actor_kind";
import { audit_0003_call_index } from "./migrations/0003_call_index";
import { audit_0004_request_index } from "./migrations/0004_request_index";
import { controlPlaneReach, controlPlaneReachStatement, controlPlaneReachSubjects } from "./reach";
import { recordAuditEvent } from "./recorder";
import { reachPatterns } from "./routePattern";

/**
 * What one credential reached — `#828`, against real D1.
 *
 * Every row is written through the real recorder, in the shapes `requireControlPlane` and a handler write them, so the
 * `json_extract` paths and the request-id join here are the ones production rows carry. A refusal is built from
 * `auditHandlerDenial`'s shape in `packages/core/src/controlPlane/http/guard.ts`, and the gate's own `auditDenial`
 * shape is here to prove it is never part of a connection's reach.
 */

const CONNECTION = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const OTHER_CONNECTION = "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
const KEY = "key-1";
const NEXT_KEY = "key-2";
const ALL_TIME = { connectionId: CONNECTION, since: new Date(0), until: new Date(10_000_000) };

const ROUTES: Pick<AdminRoute, "method" | "path">[] = [
  { method: "GET", path: "/admin/users" },
  { method: "GET", path: "/admin/users/:userId" },
  { method: "DELETE", path: "/admin/users/:userId" },
  { method: "GET", path: "/admin/users/search" },
  { method: "GET", path: "/orgs/:orgId/members/:userId" },
  // Ledger's shape: the user is the subject, and the currency after it is not.
  { method: "GET", path: "/ledger/admin/accounts/:userId/:currency/transactions" },
];
const PATTERNS = reachPatterns(ROUTES);

function db(d1: D1Database = env.DB as unknown as D1Database): AuditDatabase {
  return auditDatabase(d1);
}

async function seed(event: AuditEventInput, at: number): Promise<void> {
  await recordAuditEvent(db(), { ...event, occurredAt: new Date(at) });
}

let ray = 0;

/** An admitted call, as the gate records it, and the request id its handler's events share. */
function allowed(options: {
  path: string;
  method?: string;
  scope?: string;
  keyId?: string;
  connection?: string;
  requestId?: string | null;
}): AuditEventInput {
  const connection = options.connection ?? CONNECTION;
  return {
    action: "controlplane/call_allowed",
    outcome: "success",
    actorType: "control-plane",
    actorId: "usr_1",
    resourceType: "controlplane_connection",
    resourceId: connection,
    requestId: options.requestId === undefined ? `ray-${++ray}` : (options.requestId ?? undefined),
    ip: "203.0.113.9",
    userAgent: "Dashboard/1.0",
    metadata: {
      connectionId: connection,
      connectionEnvironment: "prod",
      scope: options.scope ?? "auth:users:read",
      keyId: options.keyId ?? KEY,
      method: options.method ?? "GET",
      path: options.path,
    },
  };
}

/** What the handler behind a call recorded: the tenant it resolved, in the same request. */
function handled(call: AuditEventInput, tenant: string | null, actorId = "usr_1"): AuditEventInput {
  return {
    action: "auth/user_read",
    outcome: "success",
    actorType: "control-plane",
    actorId,
    resourceType: "user",
    resourceId: "u_whatever",
    requestId: call.requestId,
    tenant,
    ip: "203.0.113.9",
    userAgent: "Dashboard/1.0",
    metadata: { connectionId: CONNECTION, email: "ada@example.com" },
  };
}

/** A call and its handler's event, written together. */
async function reachedCall(call: AuditEventInput, tenant: string | null, at: number): Promise<void> {
  await seed(call, at);
  if (tenant !== null) await seed(handled(call, tenant), at);
}

/**
 * A refusal a handler raised past the gate, as `auditHandlerDenial` writes it: in the same request as the gate's
 * `call_allowed` row for `call`, with the gate's requirement — which the call met — as `required`. A row written before
 * #828 names no `scope` or `keyId`; `recorded: true` adds them, as the guard now does.
 */
function refused(call: AuditEventInput, options: { recorded?: boolean } = {}): AuditEventInput {
  const metadata = call.metadata as Record<string, string>;
  return {
    action: "controlplane/call_denied",
    outcome: "denied",
    severity: "warning",
    actorType: "control-plane",
    actorId: call.actorId,
    resourceType: "controlplane_connection",
    resourceId: call.resourceId,
    requestId: call.requestId,
    ip: "203.0.113.9",
    userAgent: "Dashboard/1.0",
    metadata: {
      reason: "controlplane/insufficient_scope",
      required: metadata.scope as string,
      refusedBy: "handler",
      connectionId: call.resourceId,
      ...(options.recorded ? { scope: metadata.scope, keyId: metadata.keyId } : {}),
      method: metadata.method as string,
      path: metadata.path as string,
    },
  };
}

/** A call the gate itself refused, as `auditDenial` writes it: unverified, so no actor and no connection. */
function gateRefused(path: string): AuditEventInput {
  return {
    action: "controlplane/call_denied",
    outcome: "denied",
    severity: "warning",
    actorType: "control-plane",
    actorId: null,
    requestId: `ray-${++ray}`,
    ip: "203.0.113.9",
    userAgent: "Dashboard/1.0",
    metadata: { reason: "controlplane/insufficient_scope", required: "auth:users:delete", method: "DELETE", path },
  };
}

beforeEach(async () => {
  ray = 0;
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  for (const migration of [audit_0001_init, audit_0002_actor_kind, audit_0003_call_index, audit_0004_request_index]) {
    await migration.up(db() as unknown as Kysely<unknown>);
  }
});

describe("controlPlaneReach", () => {
  test("one row per tenant, action, method, route and outcome, grouped by the declared route", async () => {
    await reachedCall(allowed({ path: "/admin/users/u_1" }), "acme", 1_000);
    await reachedCall(allowed({ path: "/admin/users/u_2" }), "acme", 2_000);
    await reachedCall(allowed({ path: "/admin/users/u_1" }), "acme", 3_000);
    await reachedCall(allowed({ path: "/admin/users/u_9" }), "globex", 4_000);
    await reachedCall(allowed({ path: "/admin/users" }), null, 5_000);

    const reach = await controlPlaneReach(db(), ALL_TIME, PATTERNS);

    expect(reach).toEqual([
      {
        tenant: null,
        action: "controlplane/call_allowed",
        method: "GET",
        route: "/admin/users",
        matched: true,
        outcome: "success",
        scope: "auth:users:read",
        count: 1,
        subjects: 0,
        firstAt: new Date(5_000),
        lastAt: new Date(5_000),
      },
      {
        tenant: "acme",
        action: "controlplane/call_allowed",
        method: "GET",
        route: "/admin/users/:userId",
        matched: true,
        outcome: "success",
        scope: "auth:users:read",
        count: 3,
        subjects: 2,
        firstAt: new Date(1_000),
        lastAt: new Date(3_000),
      },
      {
        tenant: "globex",
        action: "controlplane/call_allowed",
        method: "GET",
        route: "/admin/users/:userId",
        matched: true,
        outcome: "success",
        scope: "auth:users:read",
        count: 1,
        subjects: 1,
        firstAt: new Date(4_000),
        lastAt: new Date(4_000),
      },
    ]);
  });

  test("a static route beats the parameter beside it, and a nested path is not the shorter route", async () => {
    await seed(allowed({ path: "/admin/users/search" }), 1_000);
    await seed(allowed({ path: "/admin/users/u_1/sessions" }), 2_000);
    await seed(allowed({ path: "/orgs/o_1/members/u_1" }), 3_000);

    const reach = await controlPlaneReach(db(), ALL_TIME, PATTERNS);

    expect(reach.map((row) => [row.route, row.matched, row.subjects])).toEqual([
      ["/admin/users/search", true, 0],
      ["/admin/users/u_1/sessions", false, null],
      ["/orgs/:orgId/members/:userId", true, 1],
    ]);
  });

  test("a called path no declared route matches is its own row, marked unmatched", async () => {
    await seed(allowed({ path: "/legacy/export" }), 1_000);
    await seed(allowed({ path: "/legacy/export" }), 2_000);
    // Same path, another method: no route answers DELETE on it either, and it is a different row.
    await seed(allowed({ path: "/admin/users", method: "DELETE" }), 3_000);

    const reach = await controlPlaneReach(db(), ALL_TIME, PATTERNS);

    expect(reach.map((row) => [row.method, row.route, row.matched, row.count, row.subjects])).toEqual([
      ["DELETE", "/admin/users", false, 1, null],
      ["GET", "/legacy/export", false, 2, null],
    ]);
  });

  test("a call its handler refused is one denied call with the scope its credential carried, not an admitted one too", async () => {
    // The gate wrote `call_allowed` before the handler ran, and the handler's refusal came after, in the same request.
    const call = allowed({ path: "/admin/users/u_1", method: "DELETE", scope: "auth:users:delete" });
    await seed(call, 1_000);
    await seed(refused(call), 1_000);
    await seed(allowed({ path: "/admin/users/u_2" }), 2_000);

    const reach = await controlPlaneReach(db(), ALL_TIME, PATTERNS);

    expect(reach.map((row) => [row.action, row.method, row.route, row.outcome, row.scope, row.count])).toEqual([
      ["controlplane/call_allowed", "GET", "/admin/users/:userId", "success", "auth:users:read", 1],
      ["controlplane/call_denied", "DELETE", "/admin/users/:userId", "denied", "auth:users:delete", 1],
    ]);
  });

  test("keyId finds a refusal, whether its own row names the key or only the gate's row in its request does", async () => {
    // Written before the guard recorded the key on a refusal: the key is the gate's row's, in the same request.
    const older = allowed({ path: "/admin/users/u_1", method: "DELETE", scope: "auth:users:delete" });
    await seed(older, 1_000);
    await seed(refused(older), 1_000);
    // Another key's refusal is not this key's.
    const otherKey = allowed({
      path: "/admin/users/u_2",
      method: "DELETE",
      scope: "auth:users:delete",
      keyId: NEXT_KEY,
    });
    await seed(otherKey, 2_000);
    await seed(refused(otherKey), 2_000);
    // With no request id there is nothing to pair by, so the refusal stands on the key its own row names, and the
    // gate's row for it stays an admitted call.
    const unpaired = allowed({
      path: "/admin/users/u_3",
      method: "DELETE",
      scope: "auth:users:delete",
      requestId: null,
    });
    await seed(unpaired, 3_000);
    await seed(refused(unpaired, { recorded: true }), 3_000);

    const oneKey = await controlPlaneReach(db(), { ...ALL_TIME, keyId: KEY }, PATTERNS);

    expect(oneKey.map((row) => [row.action, row.outcome, row.scope, row.count, row.subjects])).toEqual([
      ["controlplane/call_allowed", "success", "auth:users:delete", 1, 1],
      ["controlplane/call_denied", "denied", "auth:users:delete", 2, 2],
    ]);
  });

  test("the gate's own refusal names no verified connection, so it is no credential's reach", async () => {
    await seed(gateRefused("/admin/users/u_1"), 1_000);
    expect(await controlPlaneReach(db(), ALL_TIME, PATTERNS)).toEqual([]);
    expect(await controlPlaneReach(db(), { ...ALL_TIME, keyId: KEY }, PATTERNS)).toEqual([]);
  });

  test("the tenant is the one the call's own handler recorded, never another request's or another actor's", async () => {
    const call = allowed({ path: "/admin/users/u_1" });
    await seed(call, 1_000);
    // Another actor's event that happens to share the request id says nothing about this call.
    await seed(handled(call, "intruder", "usr_other"), 1_000);
    // Nor does an event of another actor type, even one whose actor id is the same string as the operator's.
    await seed({ ...handled(call, "impostor"), actorType: "user" }, 1_000);
    await seed({ ...handled(call, "system-tenant"), actorType: "system" }, 1_000);
    // Another request's event names a tenant this call never touched.
    await seed(handled(allowed({ path: "/x" }), "globex"), 1_000);
    // A call with no request id cannot be tied to its handler's events, so it reached no named tenant.
    await seed(allowed({ path: "/admin/users/u_2", requestId: null }), 2_000);

    const reach = await controlPlaneReach(db(), ALL_TIME, PATTERNS);

    expect(reach.map((row) => [row.tenant, row.route, row.count, row.subjects])).toEqual([
      [null, "/admin/users/:userId", 2, 2],
    ]);
  });

  test("a call whose handler recorded two tenants reached both", async () => {
    const call = allowed({ path: "/admin/users/u_1" });
    await seed(call, 1_000);
    await seed(handled(call, "acme"), 1_000);
    await seed(handled(call, "acme"), 1_000);
    await seed(handled(call, "globex"), 1_000);

    const reach = await controlPlaneReach(db(), ALL_TIME, PATTERNS);

    expect(reach.map((row) => [row.tenant, row.count])).toEqual([
      ["acme", 1],
      ["globex", 1],
    ]);
  });

  test("only this connection, inside the window, and keyId narrows to one key", async () => {
    await seed(allowed({ path: "/admin/users/u_1" }), 2_000);
    await seed(allowed({ path: "/admin/users/u_2", keyId: NEXT_KEY }), 2_000);
    await seed(allowed({ path: "/admin/users/u_3", connection: OTHER_CONNECTION }), 2_000);
    await seed(allowed({ path: "/admin/users/u_4" }), 500);
    await seed(allowed({ path: "/admin/users/u_5" }), 9_000);
    // Something else that happened to the connection is not a call.
    await seed(
      {
        action: "controlplane/key_registered",
        outcome: "success",
        actorType: "control-plane",
        resourceType: "controlplane_connection",
        resourceId: CONNECTION,
        metadata: { keyId: NEXT_KEY, method: "GET", path: "/admin/users/u_6" },
      },
      2_000,
    );
    const window = { connectionId: CONNECTION, since: new Date(1_000), until: new Date(8_000) };

    const all = await controlPlaneReach(db(), window, PATTERNS);
    const oneKey = await controlPlaneReach(db(), { ...window, keyId: NEXT_KEY }, PATTERNS);

    expect(all.map((row) => [row.count, row.subjects])).toEqual([[2, 2]]);
    expect(oneKey.map((row) => [row.count, row.subjects])).toEqual([[1, 1]]);
  });

  test("the window is inclusive at both ends", async () => {
    await seed(allowed({ path: "/admin/users" }), 1_000);
    await seed(allowed({ path: "/admin/users" }), 2_000);
    const reach = await controlPlaneReach(
      db(),
      { connectionId: CONNECTION, since: new Date(1_000), until: new Date(2_000) },
      PATTERNS,
    );
    expect(reach[0]?.count).toBe(2);
  });

  test("route narrows the rows to one route, declared or unmatched", async () => {
    await seed(allowed({ path: "/admin/users/u_1" }), 1_000);
    await seed(allowed({ path: "/admin/users" }), 2_000);
    await seed(allowed({ path: "/legacy/export" }), 3_000);

    const declared = await controlPlaneReach(db(), { ...ALL_TIME, route: "/admin/users/:userId" }, PATTERNS);
    const unmatched = await controlPlaneReach(db(), { ...ALL_TIME, route: "/legacy/export" }, PATTERNS);

    expect(declared.map((row) => row.route)).toEqual(["/admin/users/:userId"]);
    expect(unmatched.map((row) => [row.route, row.matched])).toEqual([["/legacy/export", false]]);
  });

  test("with no declared routes, every call is unmatched rather than lost", async () => {
    await seed(allowed({ path: "/admin/users/u_1" }), 1_000);
    const reach = await controlPlaneReach(db(), ALL_TIME, []);
    expect(reach.map((row) => [row.route, row.matched])).toEqual([["/admin/users/u_1", false]]);
  });

  test("an idle connection has no rows", async () => {
    await seed(allowed({ path: "/admin/users", connection: OTHER_CONNECTION }), 1_000);
    expect(await controlPlaneReach(db(), ALL_TIME, PATTERNS)).toEqual([]);
  });

  test("no row carries the IP, the user-agent, or any metadata key but the four it reads", async () => {
    const call = allowed({ path: "/admin/users/u_1" });
    await seed(call, 1_000);
    await seed(handled(call, "acme"), 1_000);

    const reach = await controlPlaneReach(db(), ALL_TIME, PATTERNS);
    const { subjects } = await controlPlaneReachSubjects(
      db(),
      { ...ALL_TIME, route: "/admin/users/:userId" },
      PATTERNS,
    );
    const serialized = JSON.stringify({ reach, subjects });

    for (const leaked of ["203.0.113.9", "Dashboard/1.0", "ada@example.com", "prod", "u_whatever", CONNECTION]) {
      expect(serialized, leaked).not.toContain(leaked);
    }
    expect(Object.keys(reach[0] ?? {}).sort()).toEqual([
      "action",
      "count",
      "firstAt",
      "lastAt",
      "matched",
      "method",
      "outcome",
      "route",
      "scope",
      "subjects",
      "tenant",
    ]);
  });
});

describe("controlPlaneReachSubjects", () => {
  test("expands a route into the subject ids its called paths name, per tenant", async () => {
    await reachedCall(allowed({ path: "/admin/users/u_1" }), "acme", 1_000);
    await reachedCall(allowed({ path: "/admin/users/u_1" }), "acme", 3_000);
    await reachedCall(allowed({ path: "/admin/users/ada%40example.com" }), "acme", 2_000);
    await reachedCall(allowed({ path: "/admin/users/u_9" }), "globex", 4_000);
    // Another route is not expanded.
    await reachedCall(allowed({ path: "/admin/users" }), "acme", 5_000);

    const { reach, subjects } = await controlPlaneReachSubjects(
      db(),
      { ...ALL_TIME, route: "/admin/users/:userId" },
      PATTERNS,
    );

    expect(subjects).toEqual([
      {
        tenant: "acme",
        action: "controlplane/call_allowed",
        method: "GET",
        route: "/admin/users/:userId",
        matched: true,
        path: "/admin/users/ada%40example.com",
        outcome: "success",
        scope: "auth:users:read",
        subjectId: "ada@example.com",
        params: { userId: "ada@example.com" },
        count: 1,
        firstAt: new Date(2_000),
        lastAt: new Date(2_000),
      },
      {
        tenant: "acme",
        action: "controlplane/call_allowed",
        method: "GET",
        route: "/admin/users/:userId",
        matched: true,
        path: "/admin/users/u_1",
        outcome: "success",
        scope: "auth:users:read",
        subjectId: "u_1",
        params: { userId: "u_1" },
        count: 2,
        firstAt: new Date(1_000),
        lastAt: new Date(3_000),
      },
      {
        tenant: "globex",
        action: "controlplane/call_allowed",
        method: "GET",
        route: "/admin/users/:userId",
        matched: true,
        path: "/admin/users/u_9",
        outcome: "success",
        scope: "auth:users:read",
        subjectId: "u_9",
        params: { userId: "u_9" },
        count: 1,
        firstAt: new Date(4_000),
        lastAt: new Date(4_000),
      },
    ]);
    // The route's own rows, folded from the same statement, agree with the aggregate read.
    expect(reach).toEqual(await controlPlaneReach(db(), { ...ALL_TIME, route: "/admin/users/:userId" }, PATTERNS));
  });

  test("the subject id is the route's last id parameter, and every parameter is named", async () => {
    await seed(allowed({ path: "/orgs/o_1/members/u_2" }), 1_000);
    const { subjects } = await controlPlaneReachSubjects(
      db(),
      { ...ALL_TIME, route: "/orgs/:orgId/members/:userId" },
      PATTERNS,
    );
    expect(subjects.map((row) => [row.subjectId, row.params])).toEqual([["u_2", { orgId: "o_1", userId: "u_2" }]]);
  });

  test("on a route whose last parameter is not an id, the subject is the user, and the count is of users", async () => {
    const route = "/ledger/admin/accounts/:userId/:currency/transactions";
    await seed(
      allowed({ path: "/ledger/admin/accounts/u_1/USD/transactions", scope: "ledger:transactions:read" }),
      1_000,
    );
    await seed(
      allowed({ path: "/ledger/admin/accounts/u_1/EUR/transactions", scope: "ledger:transactions:read" }),
      2_000,
    );
    await seed(
      allowed({ path: "/ledger/admin/accounts/u_2/USD/transactions", scope: "ledger:transactions:read" }),
      3_000,
    );

    const { reach, subjects } = await controlPlaneReachSubjects(db(), { ...ALL_TIME, route }, PATTERNS);
    const aggregate = await controlPlaneReach(db(), { ...ALL_TIME, route }, PATTERNS);

    expect(subjects.map((row) => [row.subjectId, row.params])).toEqual([
      ["u_1", { userId: "u_1", currency: "EUR" }],
      ["u_1", { userId: "u_1", currency: "USD" }],
      ["u_2", { userId: "u_2", currency: "USD" }],
    ]);
    // Three paths, two users: one user read in two currencies is one subject.
    expect(aggregate.map((row) => [row.route, row.count, row.subjects])).toEqual([[route, 3, 2]]);
    expect(reach).toEqual(aggregate);
  });

  test("an unmatched path expands into itself, naming no subject", async () => {
    await seed(allowed({ path: "/legacy/export" }), 1_000);
    const { subjects } = await controlPlaneReachSubjects(db(), { ...ALL_TIME, route: "/legacy/export" }, PATTERNS);
    expect(subjects.map((row) => [row.path, row.matched, row.subjectId, row.params])).toEqual([
      ["/legacy/export", false, null, {}],
    ]);
  });
});

describe("the reach is one SQL statement, not a page walk", () => {
  /** Ten thousand allowed calls over a thousand users and two tenants, written in one statement so the fixture is quick. */
  async function tenThousandCalls(): Promise<void> {
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
       insert into pithy_audit_events
         (event_id, occurred_at, action, outcome, severity, actor_type, actor_id, resource_type, resource_id, request_id, ip, user_agent, metadata)
       select 'evt-' || i, i, 'controlplane/call_allowed', 'success', 'info', 'control-plane', 'usr_1',
              'controlplane_connection', ?, 'ray-' || i, '203.0.113.9', 'Dashboard/1.0',
              json_object('connectionId', ?, 'scope', 'auth:users:read', 'keyId', ?, 'method', 'GET',
                          'path', '/admin/users/u_' || (i % 1000))
       from n`,
    )
      .bind(CONNECTION, CONNECTION, KEY)
      .run();
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
       insert into pithy_audit_events
         (event_id, occurred_at, action, outcome, severity, actor_type, actor_id, request_id, tenant)
       select 'handled-' || i, i, 'auth/user_read', 'success', 'info', 'control-plane', 'usr_1', 'ray-' || i,
              case when i % 2 = 0 then 'acme' else 'globex' end
       from n`,
    ).run();
  }

  /** A D1 that records every statement prepared against it. */
  function counting(statements: string[]): D1Database {
    return new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            statements.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as D1Database;
  }

  test("ten thousand events answer in one statement", async () => {
    await tenThousandCalls();
    const statements: string[] = [];

    const reach = await controlPlaneReach(db(counting(statements)), ALL_TIME, PATTERNS);

    expect(statements).toHaveLength(1);
    expect(reach.map((row) => [row.tenant, row.route, row.count, row.subjects, row.firstAt, row.lastAt])).toEqual([
      ["acme", "/admin/users/:userId", 5_000, 500, new Date(2), new Date(10_000)],
      ["globex", "/admin/users/:userId", 5_000, 500, new Date(1), new Date(9_999)],
    ]);
  });

  test("the subjects of ten thousand events answer in one statement too", async () => {
    await tenThousandCalls();
    const statements: string[] = [];

    const { reach, subjects } = await controlPlaneReachSubjects(
      db(counting(statements)),
      { ...ALL_TIME, route: "/admin/users/:userId" },
      PATTERNS,
    );

    expect(statements).toHaveLength(1);
    expect(subjects).toHaveLength(1_000);
    expect(subjects.every((row) => row.count === 10)).toBe(true);
    expect(reach.map((row) => [row.tenant, row.count, row.subjects])).toEqual([
      ["acme", 5_000, 500],
      ["globex", 5_000, 500],
    ]);
  });

  test("the query plan reads the call and request indexes, not the table", async () => {
    await tenThousandCalls();
    await env.DB.prepare("analyze").run();
    const { sql, parameters } = controlPlaneReachStatement(db(), ALL_TIME, PATTERNS).compile();

    const plan = await env.DB.prepare(`explain query plan ${sql}`)
      .bind(...parameters)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);

    expect(
      details.some((detail) => detail.includes("pithy_audit_events_call_idx")),
      details.join("\n"),
    ).toBe(true);
    expect(
      details.some((detail) => detail.includes("pithy_audit_events_request_idx")),
      details.join("\n"),
    ).toBe(true);
    expect(
      details.some((detail) => /^SCAN pithy_audit_events\b/.test(detail)),
      details.join("\n"),
    ).toBe(false);
  });
});
