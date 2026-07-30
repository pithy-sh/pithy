// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { AuditEventInput } from "../audit/auditEvent";
import { noopEmit } from "../audit/recorder";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import type { AuthContext } from "../http/authContext";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/record";
import { type Entitlement, type EntitlementResolver, noEntitlementProvider } from "./entitlement";
import { requireAnyEntitlement, requireEntitlement } from "./require";

/** A resolver that holds exactly what a case is about, standing in for `@pithy-sh/payments`. */
function provider(entitlements: readonly Entitlement[]): EntitlementResolver {
  return { provider: "payments", list: async () => entitlements };
}

const held = (overrides: Partial<Entitlement> = {}): Entitlement => ({
  key: "pro",
  active: true,
  expiresAt: null,
  source: "purchase_1",
  ...overrides,
});

const signedIn: AuthContext = { userId: "user_1", sessionId: "session_1", scopes: [] };

interface AppOptions {
  auth?: AuthContext | null;
  entitlements?: EntitlementResolver;
  emit?: (event: AuditEventInput) => Promise<void>;
  logs?: LogRecord[];
  gate?: ReturnType<typeof requireEntitlement>;
}

/**
 * The seams a gate reads, seeded the way `createBackend` seeds them, and nothing else. No capabilities,
 * no bindings, no request body — the gate's whole input is `auth` and `entitlements`, with `emit` and
 * `log` for what it records. `log` is seeded because `createBackend` guarantees a real logger on every
 * request, so nothing in the gate null-checks it.
 */
function makeApp(options: AppOptions = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const records = options.logs ?? [];
  app.use("*", async (c, next) => {
    c.set("auth", options.auth ?? null);
    c.set("entitlements", options.entitlements ?? noEntitlementProvider);
    c.set("emit", options.emit ?? noopEmit);
    c.set("log", createLogger({ level: "debug", sink: (record) => records.push(record) }));
    await next();
  });
  app.get("/pro", options.gate ?? requireEntitlement("pro"), (c) => c.json({ ok: true }, 200));
  return app;
}

describe("requireEntitlement", () => {
  test("an entitled caller passes", async () => {
    const response = await makeApp({ auth: signedIn, entitlements: provider([held()]) }).request("/pro");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("a caller holding a different entitlement is denied", async () => {
    const response = await makeApp({
      auth: signedIn,
      entitlements: provider([held({ key: "ads_removed" })]),
    }).request("/pro");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "payments/entitlement_required" } });
  });

  test("a lapsed grant is denied at read time, with no write having revoked it", async () => {
    // The row still says `active: true`; only `expiresAt` has passed. The gate applies the rule.
    const response = await makeApp({
      auth: signedIn,
      entitlements: provider([held({ active: true, expiresAt: new Date(Date.now() - 1000) })]),
    }).request("/pro");
    expect(response.status).toBe(403);
  });

  test("an unauthenticated caller is denied 401, not 403", async () => {
    // Which failure it is matters: 403 would tell an anonymous caller the route exists and is paid.
    const response = await makeApp({ auth: null, entitlements: provider([held()]) }).request("/pro");
    expect(response.status).toBe(401);
  });

  test("the response never says why it was denied beyond the code", async () => {
    const response = await makeApp({ auth: signedIn, entitlements: noEntitlementProvider }).request("/pro");
    const { error } = (await response.json()) as { error: Record<string, unknown> };
    // The HTTP codec strips `detail`, which is where the missing provider and the required key are
    // named. What reaches the client is the code, a generic message, and an action.
    expect(error).not.toHaveProperty("detail");
    expect(JSON.stringify(error)).not.toContain("user_1");
    expect(error.message).not.toMatch(/composed|provider/i);
  });
});

describe("the seam fails closed", () => {
  test("with no provider composed, an entitled-looking request is still denied", async () => {
    // The headline property. `noEntitlementProvider` is what `createBackend` seeds, so a Worker that
    // gates a route while composing no payments capability denies rather than waves everyone through.
    const response = await makeApp({ auth: signedIn, entitlements: noEntitlementProvider }).request("/pro");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "payments/entitlement_required" } });
  });

  test("a denial names the missing provider in detail, where only an operator sees it", async () => {
    const events: AuditEventInput[] = [];
    await makeApp({
      auth: signedIn,
      entitlements: noEntitlementProvider,
      emit: async (event) => {
        events.push(event);
      },
    }).request("/pro");
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ provider: null });
  });

  test("a resolver that throws denies rather than passing, and says so in the log", async () => {
    // A provider whose database is unreachable must not become an open door. The operator needs to
    // tell "unentitled" from "broken"; the client cannot be told, so the difference lives in the log.
    const broken: EntitlementResolver = {
      provider: "payments",
      list: async () => {
        throw new Error("D1 unreachable");
      },
    };
    const logs: LogRecord[] = [];
    const response = await makeApp({ auth: signedIn, entitlements: broken, logs }).request("/pro");
    expect(response.status).toBe(403);
    expect(logs.filter((r) => r.level === "error").map((r) => r.msg)).toEqual(["entitlement resolution failed"]);
  });
});

describe("audit", () => {
  test("a denied gate records a denied audit event", async () => {
    const events: AuditEventInput[] = [];
    const response = await makeApp({
      auth: signedIn,
      entitlements: provider([]),
      emit: async (event) => {
        events.push(event);
      },
    }).request("/pro");
    expect(response.status).toBe(403);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "entitlement/denied",
      outcome: "denied",
      actorType: "user",
      actorId: "user_1",
      resourceType: "entitlement",
      resourceId: "pro",
    });
  });

  test("a passing gate records nothing", async () => {
    const events: AuditEventInput[] = [];
    await makeApp({
      auth: signedIn,
      entitlements: provider([held()]),
      emit: async (event) => {
        events.push(event);
      },
    }).request("/pro");
    expect(events).toEqual([]);
  });

  test("an unauthenticated denial records nothing — there is no actor to attribute it to", async () => {
    const events: AuditEventInput[] = [];
    await makeApp({
      auth: null,
      emit: async (event) => {
        events.push(event);
      },
    }).request("/pro");
    expect(events).toEqual([]);
  });
});

describe("requireAnyEntitlement", () => {
  test("holding one of the listed keys passes", async () => {
    const response = await makeApp({
      auth: signedIn,
      entitlements: provider([held({ key: "lifetime" })]),
      gate: requireAnyEntitlement(["pro", "lifetime"]),
    }).request("/pro");
    expect(response.status).toBe(200);
  });

  test("holding none of them is denied", async () => {
    const response = await makeApp({
      auth: signedIn,
      entitlements: provider([held({ key: "ads_removed" })]),
      gate: requireAnyEntitlement(["pro", "lifetime"]),
    }).request("/pro");
    expect(response.status).toBe(403);
  });

  test("an empty key list is an authoring error, not a route that everyone passes", async () => {
    // `requireAnyEntitlement([])` reads like "no entitlement needed" but would deny every caller. It
    // is refused at construction so the mistake surfaces on deploy rather than as a dead route.
    expect(() => requireAnyEntitlement([])).toThrow(/at least one entitlement/i);
  });

  test("a key that is not a valid entitlement key is refused at construction", () => {
    // A SKU where a key belongs would gate on something no projection ever writes.
    expect(() => requireEntitlement("com.acme.pro.monthly")).toThrow();
  });
});
