// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { type AuditDatabase, auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { audit_0002_actor_kind } from "./migrations/0002_actor_kind";
import { audit_0003_call_index } from "./migrations/0003_call_index";
import { recordAuditEvent } from "./recorder";
import { controlPlaneUsage, controlPlaneUsageStatement } from "./usage";

/**
 * Which scopes a connection exercised, and which it was refused — `#812`, against real D1.
 *
 * Every row is written through the real recorder, in the shapes `requireControlPlane` writes them, so the
 * `json_extract` paths here are the ones production rows carry.
 */

const CONNECTION = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const OTHER_CONNECTION = "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
const KEY = "key-1";
const NEXT_KEY = "key-2";
const ALL_TIME = { since: new Date(0), until: new Date(10_000_000) };

function db(d1: D1Database = env.DB as unknown as D1Database): AuditDatabase {
  return auditDatabase(d1);
}

async function seed(event: AuditEventInput, at: number): Promise<void> {
  await recordAuditEvent(db(), { ...event, occurredAt: new Date(at) });
}

/** An admitted call, as the gate records it. */
function allowed(options: {
  scope: string;
  keyId?: string;
  connection?: string;
  method?: string;
  path?: string;
}): AuditEventInput {
  const connection = options.connection ?? CONNECTION;
  return {
    action: "controlplane/call_allowed",
    outcome: "success",
    actorType: "control-plane",
    actorId: "usr_1",
    resourceType: "controlplane_connection",
    resourceId: connection,
    ip: "203.0.113.9",
    userAgent: "Dashboard/1.0",
    metadata: {
      connectionId: connection,
      connectionEnvironment: "prod",
      scope: options.scope,
      keyId: options.keyId ?? KEY,
      method: options.method ?? "GET",
      path: options.path ?? "/audit/events",
    },
  };
}

/** A verified call the gate refused for a scope it was not granted. */
function gateDenied(required: string, keyId = KEY): AuditEventInput {
  return {
    action: "controlplane/call_denied",
    outcome: "denied",
    severity: "warning",
    actorType: "control-plane",
    actorId: "usr_1",
    resourceType: "controlplane_connection",
    resourceId: CONNECTION,
    metadata: { reason: "controlplane/insufficient_scope", required, method: "POST", path: "/x", keyId },
  };
}

/** A refusal a handler wrote, naming the scope it found missing as `metadata.scope`. */
function handlerDenied(scope: string, keyId = KEY): AuditEventInput {
  return {
    action: "controlplane/call_denied",
    outcome: "denied",
    severity: "warning",
    actorType: "control-plane",
    actorId: "usr_1",
    resourceType: "controlplane_connection",
    resourceId: CONNECTION,
    metadata: { reason: "controlplane/insufficient_scope", scope, keyId, method: "GET", path: "/y" },
  };
}

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  for (const migration of [audit_0001_init, audit_0002_actor_kind, audit_0003_call_index]) {
    await migration.up(db() as unknown as Kysely<unknown>);
  }
});

describe("controlPlaneUsage", () => {
  test("one row per scope and key, counting calls, with the last allowed call's method and path", async () => {
    await seed(allowed({ scope: "audit:events:read", path: "/audit/events?first" }), 1_000);
    await seed(allowed({ scope: "audit:events:read", method: "GET", path: "/audit/events?last" }), 3_000);
    await seed(allowed({ scope: "audit:events:read", path: "/audit/events?middle" }), 2_000);
    await seed(allowed({ scope: "audit:events:read", keyId: NEXT_KEY }), 4_000);
    await seed(gateDenied("audit:events:read"), 5_000);

    const { usage } = await controlPlaneUsage(db(), { connectionId: CONNECTION, ...ALL_TIME });

    expect(usage).toEqual([
      {
        scope: "audit:events:read",
        keyId: KEY,
        allowed: 3,
        denied: 1,
        lastAllowedAt: new Date(3_000),
        lastAllowedMethod: "GET",
        lastAllowedPath: "/audit/events?last",
        lastDeniedAt: new Date(5_000),
      },
      {
        scope: "audit:events:read",
        keyId: NEXT_KEY,
        allowed: 1,
        denied: 0,
        lastAllowedAt: new Date(4_000),
        lastAllowedMethod: "GET",
        lastAllowedPath: "/audit/events",
        lastDeniedAt: null,
      },
    ]);
  });

  test("a scope denied and never allowed appears with allowed 0, whichever refused it", async () => {
    await seed(gateDenied("payments:overrides:set"), 1_000);
    await seed(handlerDenied("ledger:accounts:adjust"), 2_000);

    const { usage } = await controlPlaneUsage(db(), { connectionId: CONNECTION, ...ALL_TIME });

    expect(usage.map((row) => [row.scope, row.allowed, row.denied, row.lastAllowedAt, row.lastDeniedAt])).toEqual([
      ["ledger:accounts:adjust", 0, 1, null, new Date(2_000)],
      ["payments:overrides:set", 0, 1, null, new Date(1_000)],
    ]);
    expect(usage[0]?.lastAllowedMethod).toBeNull();
    expect(usage[0]?.lastAllowedPath).toBeNull();
  });

  test("counts only this connection, inside the window, and only its calls", async () => {
    await seed(allowed({ scope: "audit:events:read" }), 2_000);
    // Another connection's calls.
    await seed(allowed({ scope: "audit:events:read", connection: OTHER_CONNECTION }), 2_000);
    // Outside the window on either side.
    await seed(allowed({ scope: "audit:events:read" }), 500);
    await seed(allowed({ scope: "audit:events:read" }), 9_000);
    // An unverified refusal: no connection is proven, so it is nobody's usage.
    await seed(
      {
        action: "controlplane/call_denied",
        outcome: "denied",
        actorType: "control-plane",
        actorId: null,
        metadata: { reason: "controlplane/invalid_credential", required: "keys:rotate", method: "GET", path: "/" },
      },
      2_000,
    );
    // Something else that happened to the connection is not a call.
    await seed(
      {
        action: "controlplane/key_registered",
        outcome: "success",
        actorType: "control-plane",
        resourceType: "controlplane_connection",
        resourceId: CONNECTION,
        metadata: { scope: "keys:rotate", keyId: NEXT_KEY },
      },
      2_000,
    );

    const { usage } = await controlPlaneUsage(db(), {
      connectionId: CONNECTION,
      since: new Date(1_000),
      until: new Date(8_000),
    });

    expect(usage.map((row) => [row.scope, row.keyId, row.allowed, row.denied])).toEqual([
      ["audit:events:read", KEY, 1, 0],
    ]);
  });

  test("the window is inclusive at both ends", async () => {
    await seed(allowed({ scope: "audit:events:read" }), 1_000);
    await seed(allowed({ scope: "audit:events:read" }), 2_000);
    const { usage } = await controlPlaneUsage(db(), {
      connectionId: CONNECTION,
      since: new Date(1_000),
      until: new Date(2_000),
    });
    expect(usage[0]?.allowed).toBe(2);
  });

  test("a scope never exercised does not appear, and an idle connection has no rows", async () => {
    await seed(allowed({ scope: "audit:events:read", connection: OTHER_CONNECTION }), 1_000);
    const { usage } = await controlPlaneUsage(db(), { connectionId: CONNECTION, ...ALL_TIME });
    expect(usage).toEqual([]);
  });

  test("oldestEventAt is the oldest event the trail holds, whatever the window or connection", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, 700);
    await seed(allowed({ scope: "audit:events:read", connection: OTHER_CONNECTION }), 1_500);
    await seed(allowed({ scope: "audit:events:read" }), 3_000);

    const result = await controlPlaneUsage(db(), {
      connectionId: CONNECTION,
      since: new Date(2_000),
      until: new Date(4_000),
    });

    expect(result.oldestEventAt).toEqual(new Date(700));
  });

  test("oldestEventAt is null on an empty trail", async () => {
    const result = await controlPlaneUsage(db(), { connectionId: CONNECTION, ...ALL_TIME });
    expect(result).toEqual({ usage: [], oldestEventAt: null });
  });
});

describe("the aggregate is SQL, not a page walk", () => {
  /** Ten thousand allowed calls across two scopes, written in one statement so the fixture costs no time. */
  async function tenThousandCalls(): Promise<void> {
    const metadata = (scope: string) =>
      JSON.stringify({ connectionId: CONNECTION, scope, keyId: KEY, method: "GET", path: `/${scope}` });
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
       insert into pithy_audit_events
         (event_id, occurred_at, action, outcome, severity, actor_type, actor_id, resource_type, resource_id, ip, user_agent, metadata)
       select 'evt-' || i, i, 'controlplane/call_allowed', 'success', 'info', 'control-plane', 'usr_1',
              'controlplane_connection', ?, '203.0.113.9', 'Dashboard/1.0',
              case when i % 4 = 0 then ? else ? end
       from n`,
    )
      .bind(CONNECTION, metadata("audit:events:read_detail"), metadata("audit:events:read"))
      .run();
  }

  test("ten thousand events answer in two statements: the aggregate, and the trail's oldest event", async () => {
    await tenThousandCalls();
    const statements: string[] = [];
    const counted = new Proxy(env.DB, {
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
    });

    const { usage, oldestEventAt } = await controlPlaneUsage(db(counted as unknown as D1Database), {
      connectionId: CONNECTION,
      ...ALL_TIME,
    });

    expect(statements).toHaveLength(2);
    expect(statements.filter((query) => /group by/i.test(query))).toHaveLength(1);
    expect(usage.map((row) => [row.scope, row.allowed, row.lastAllowedAt])).toEqual([
      ["audit:events:read", 7_500, new Date(9_999)],
      ["audit:events:read_detail", 2_500, new Date(10_000)],
    ]);
    expect(oldestEventAt).toEqual(new Date(1));
  });

  test("the query plan reads the call index, not the table", async () => {
    await tenThousandCalls();
    // Fresh statistics, as a long-lived trail has, so the planner chooses on the real distribution.
    await env.DB.prepare("analyze").run();
    const { sql, parameters } = controlPlaneUsageStatement(db(), { connectionId: CONNECTION, ...ALL_TIME }).compile();

    const plan = await env.DB.prepare(`explain query plan ${sql}`)
      .bind(...parameters)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);

    expect(
      details.some((detail) => detail.includes("pithy_audit_events_call_idx")),
      details.join("\n"),
    ).toBe(true);
    expect(
      details.some((detail) => /^SCAN pithy_audit_events\b/.test(detail)),
      details.join("\n"),
    ).toBe(false);
  });
});
