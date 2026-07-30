// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { noEntitlementProvider } from "@pithy-sh/core/src/entitlement/entitlement";
import { requireEntitlement } from "@pithy-sh/core/src/entitlement/require";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import {
  createPaymentsEntitlementResolver,
  installEntitlementResolver,
  PAYMENTS_ENTITLEMENT_PROVIDER,
} from "./resolver";

/**
 * The resolver middleware against real D1: what a gate on a paid route actually sees.
 *
 * The middleware is mounted *before* the fake auth middleware on purpose. Middleware order is the adopter's
 * — it follows the `capabilities` array in their `pithy.config.ts` — so a resolver that read `c.var.auth` at
 * install time would resolve the wrong caller, or none, depending on where payments happened to sit. These
 * tests pin the unfavourable order so that regression cannot pass.
 */

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = 1_700_000_000_000;

/**
 * The middleware resolves against the real clock — it is the request's clock, and injecting one would mean
 * a seam nothing in production would use. So the middleware's fixtures are relative to now, and only the
 * direct-resolver tests below pin a timestamp.
 */
const LIVE = Date.now() + 30 * DAY;
const LAPSED = Date.now() - DAY;

async function grant(options: { userId: string; entitlement: string; active: 0 | 1; expiresAt: number | null }) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_entitlements (id, user_id, entitlement, active, expires_at, source_purchase_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'p1', ?, ?)",
  )
    .bind(crypto.randomUUID(), options.userId, options.entitlement, options.active, options.expiresAt, T0, T0)
    .run();
}

/** A minimal backend: the resolver installed first, a fake auth strategy second, then the gated route. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    // What `createBackend` seeds: the fail-closed default, the no-op audit sink, the logger, and `db`.
    c.set("entitlements", noEntitlementProvider);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    c.set("db", { app: paymentsDatabase(env.DB) });
    await next();
  });
  installEntitlementResolver("app")(app);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    await next();
  });
  app.get("/paid", requireEntitlement("pro"), (c) => c.json({ ok: true }));
  return app;
}

const get = (app: Hono<PithyHonoEnv>, user?: string) =>
  app.request("http://x/paid", { headers: user ? { "x-user": user } : {} }, env);

beforeEach(async () => {
  for (const table of [
    "pithy_payments_purchases",
    "pithy_payments_entitlements",
    "pithy_payments_provider_accounts",
    "pithy_payments_webhook_events",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

describe("installEntitlementResolver", () => {
  test("names payments as the provider, replacing core's fail-closed default", async () => {
    const app = new Hono<PithyHonoEnv>();
    let seen: string | null | undefined;
    app.use("*", async (c, next) => {
      c.set("entitlements", noEntitlementProvider);
      await next();
    });
    installEntitlementResolver("app")(app);
    app.get("/x", (c) => {
      seen = c.var.entitlements.provider;
      return c.json({});
    });
    await app.request("http://x/x", {}, env);
    expect(seen).toBe(PAYMENTS_ENTITLEMENT_PROVIDER);
  });

  test("a gate passes for a caller whose entitlement row is live", async () => {
    await grant({ userId: "ada", entitlement: "pro", active: 1, expiresAt: LIVE });
    expect((await get(makeApp(), "ada")).status).toBe(200);
  });

  test("it resolves the caller even though auth's middleware is mounted after it", async () => {
    // The resolver reads `c.var.auth` inside `list()`, so the adopter's capability order cannot break it.
    await grant({ userId: "grace", entitlement: "pro", active: 1, expiresAt: null });
    expect((await get(makeApp(), "grace")).status).toBe(200);
    // And it is scoped to the caller, not to whoever wrote a row.
    expect((await get(makeApp(), "ada")).status).toBe(403);
  });

  test("with no authenticated caller it holds nothing, and the gate 401s rather than 403s", async () => {
    await grant({ userId: "ada", entitlement: "pro", active: 1, expiresAt: null });
    // A gate is not an identity check: an anonymous caller must not learn that the route exists and is paid.
    expect((await get(makeApp())).status).toBe(401);
  });

  test("a lapsed row does not open the gate, even though the stored flag still says active", async () => {
    await grant({ userId: "ada", entitlement: "pro", active: 1, expiresAt: LAPSED });
    const response = await get(makeApp(), "ada");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "payments/entitlement_required" } });
  });

  test("the denial carries no internal detail — detail is stripped on the way out", async () => {
    const body = await (await get(makeApp(), "ada")).text();
    expect(body).not.toMatch(/detail/);
    expect(body).not.toMatch(/payments resolved/);
  });

  test("a caller holding a different entitlement is still denied this one", async () => {
    await grant({ userId: "ada", entitlement: "ads_removed", active: 1, expiresAt: null });
    expect((await get(makeApp(), "ada")).status).toBe(403);
  });
});

describe("createPaymentsEntitlementResolver", () => {
  test("resolves one user's entitlements, and names payments as the provider", async () => {
    await grant({ userId: "ada", entitlement: "pro", active: 1, expiresAt: null });
    const resolver = createPaymentsEntitlementResolver(paymentsDatabase(env.DB), "ada", () => new Date(T0));
    expect(resolver.provider).toBe("payments");
    expect((await resolver.list()).map((e) => [e.key, e.active])).toEqual([["pro", true]]);
  });

  test("the injected clock decides the recheck, so a grant lapses without any write", async () => {
    await grant({ userId: "ada", entitlement: "pro", active: 1, expiresAt: T0 + DAY });
    const db = paymentsDatabase(env.DB);
    expect((await createPaymentsEntitlementResolver(db, "ada", () => new Date(T0)).list())[0]?.active).toBe(true);
    expect((await createPaymentsEntitlementResolver(db, "ada", () => new Date(T0 + 2 * DAY)).list())[0]?.active).toBe(
      false,
    );
  });
});
