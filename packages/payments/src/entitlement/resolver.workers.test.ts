// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Entitlement } from "@pithy-sh/core/src/entitlement/entitlement";
import { noEntitlementProvider } from "@pithy-sh/core/src/entitlement/entitlement";
import { requireEntitlement } from "@pithy-sh/core/src/entitlement/require";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { encodeSubjectReference, type PaymentsSubject } from "../data/subject";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import {
  createPaymentsEntitlementResolver,
  installEntitlementResolver,
  PAYMENTS_ENTITLEMENT_PROVIDER,
  paymentsEntitlementHolder,
} from "./resolver";
import type { PaymentsSubjectSeam } from "./subjectSeam";

/**
 * The resolver middleware against real D1: what a gate on a paid route actually sees.
 *
 * The middleware is mounted *before* the fake auth middleware on purpose. Middleware order is the adopter's
 * — it follows the `capabilities` array in their `pithy.config.ts` — so a resolver that read `c.var.auth` at
 * install time would resolve the wrong caller, or none, depending on where payments happened to sit. These
 * tests pin the unfavourable order so that regression cannot pass.
 *
 * The subject is resolved on the same schedule and for the same reason, and two of its properties are load
 * bearing enough to be pinned here rather than only in `subjectSeam.test.ts`. An **unanswered** seam holds
 * nothing and the gate refuses, whatever the caller's own user id would have resolved to. And it holds
 * nothing **before** the database is looked at, so an unanswered request on a Worker with no `DB` bound is
 * a denial from the gate rather than a 500 from a wiring check that had no business running yet.
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

/** The people and the companies these tests read as. */
const ADA: PaymentsSubject = { subjectType: "user", subjectId: "ada" };
const GRACE: PaymentsSubject = { subjectType: "user", subjectId: "grace" };
const ACME: PaymentsSubject = { subjectType: "organization", subjectId: "acme" };
const GLOBEX: PaymentsSubject = { subjectType: "organization", subjectId: "globex" };

/** The default project: one person buys, one person is entitled, and no adopter seam is wired. */
const USER_BILLED: PaymentsSubjectSeam = { billingSubject: "user" };

/** A project that bills organizations and never wired the seam. Nothing can resolve, deliberately. */
const UNANSWERED: PaymentsSubjectSeam = { billingSubject: "organization" };

/** A project that bills organizations, answering from a header the way an adopter answers from a session. */
const ORGANIZATION_BILLED: PaymentsSubjectSeam = {
  billingSubject: "organization",
  resolveSubject: async (c) => {
    const acting = c.req.header("x-org");
    return acting ? { subjectType: "organization", subjectId: acting } : undefined;
  },
};

async function grant(options: {
  subject: PaymentsSubject;
  entitlement: string;
  active: 0 | 1;
  expiresAt: number | null;
}) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_entitlements (id, subject_type, subject_id, entitlement, active, expires_at, source_purchase_id, manual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'p1', 0, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      options.subject.subjectType,
      options.subject.subjectId,
      options.entitlement,
      options.active,
      options.expiresAt,
      T0,
      T0,
    )
    .run();
}

interface AppOptions {
  /** The billing mode and the adopter's seam. */
  seam?: PaymentsSubjectSeam;
  /** Compose the app database. Off means `c.var.db` carries no `app`, as an unbound `DB` would. */
  withDatabase?: boolean;
}

/** A minimal backend: the resolver installed first, a fake auth strategy second, then the gated route. */
function makeApp(options: AppOptions = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    // What `createBackend` seeds: the fail-closed default, the no-op audit sink, the logger, and `db`.
    c.set("entitlements", noEntitlementProvider);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    c.set("db", options.withDatabase === false ? {} : { app: paymentsDatabase(env.DB) });
    await next();
  });
  installEntitlementResolver("app", options.seam ?? USER_BILLED)(app);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    await next();
  });
  app.get("/paid", requireEntitlement("pro"), (c) => c.json({ ok: true }));
  // The seam's own answer, unmediated by the gate — the gate swallows a throw from `list()` into a denial,
  // so the difference between "held nothing" and "raised" is only visible from here.
  app.get("/held", async (c) => {
    try {
      return c.json({ held: (await c.var.entitlements.list()).map((held) => held.key) });
    } catch (error) {
      return c.json({ code: error instanceof PithyError ? error.payload.code : "not-a-pithy-error" }, 500);
    }
  });
  // The holder the resolver reports, which core puts in a denial's `detail` and on its audit row. Probed
  // directly because both destinations are stripped or internal by the time anything else could see it.
  app.get("/holder", async (c) => c.json({ holder: (await c.var.entitlements.holder?.()) ?? null }));
  return app;
}

/** Call the gated route as a caller, and as a caller acting for an organization. */
const get = (app: Hono<PithyHonoEnv>, headers: Record<string, string> = {}) =>
  app.request("http://x/paid", { headers }, env);

const held = (app: Hono<PithyHonoEnv>, headers: Record<string, string> = {}) =>
  app.request("http://x/held", { headers }, env);

beforeEach(async () => {
  for (const table of [
    "pithy_payments_purchases",
    "pithy_payments_entitlements",
    "pithy_payments_provider_accounts",
    "pithy_payments_webhook_events",
    "pithy_payments_reconcile_runs",
    "pithy_payments_sync_cursors",
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
    installEntitlementResolver("app", USER_BILLED)(app);
    app.get("/x", (c) => {
      seen = c.var.entitlements.provider;
      return c.json({});
    });
    await app.request("http://x/x", {}, env);
    expect(seen).toBe(PAYMENTS_ENTITLEMENT_PROVIDER);
  });

  test("it still names payments when no subject resolves — payments is composed either way", async () => {
    // Reporting `null` here would send an operator hunting a capability that is present and working. The
    // denial's own `detail` is what says the caller held nothing.
    let seen: string | null | undefined;
    const app = makeApp({ seam: UNANSWERED });
    app.get("/provider", (c) => {
      seen = c.var.entitlements.provider;
      return c.json({});
    });
    await app.request("http://x/provider", {}, env);
    expect(seen).toBe(PAYMENTS_ENTITLEMENT_PROVIDER);
  });

  test("a gate passes for a caller whose entitlement row is live", async () => {
    await grant({ subject: ADA, entitlement: "pro", active: 1, expiresAt: LIVE });
    expect((await get(makeApp(), { "x-user": "ada" })).status).toBe(200);
  });

  test("it resolves the caller even though auth's middleware is mounted after it", async () => {
    // The resolver reads `c.var.auth` inside `list()`, so the adopter's capability order cannot break it.
    await grant({ subject: GRACE, entitlement: "pro", active: 1, expiresAt: null });
    expect((await get(makeApp(), { "x-user": "grace" })).status).toBe(200);
    // And it is scoped to the caller, not to whoever wrote a row.
    expect((await get(makeApp(), { "x-user": "ada" })).status).toBe(403);
  });

  test("with no authenticated caller it holds nothing, and the gate 401s rather than 403s", async () => {
    await grant({ subject: ADA, entitlement: "pro", active: 1, expiresAt: null });
    // A gate is not an identity check: an anonymous caller must not learn that the route exists and is paid.
    expect((await get(makeApp())).status).toBe(401);
  });

  test("a lapsed row does not open the gate, even though the stored flag still says active", async () => {
    await grant({ subject: ADA, entitlement: "pro", active: 1, expiresAt: LAPSED });
    const response = await get(makeApp(), { "x-user": "ada" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "payments/entitlement_required" } });
  });

  test("the denial carries no internal detail — detail is stripped on the way out", async () => {
    const body = await (await get(makeApp(), { "x-user": "ada" })).text();
    expect(body).not.toMatch(/detail/);
    expect(body).not.toMatch(/payments resolved/);
  });

  test("a caller holding a different entitlement is still denied this one", async () => {
    await grant({ subject: ADA, entitlement: "ads_removed", active: 1, expiresAt: null });
    expect((await get(makeApp(), { "x-user": "ada" })).status).toBe(403);
  });
});

describe("an unanswered subject", () => {
  test("holds nothing, and the gate refuses a caller whose own user row would have granted it", async () => {
    // The acceptance criterion, planted: the seam answers nothing, so nobody is entitled — not even the
    // signed-in person whose user-keyed row is sitting right there. There is no fallback to `auth.userId`.
    await grant({ subject: ADA, entitlement: "pro", active: 1, expiresAt: null });
    const app = makeApp({ seam: UNANSWERED });
    expect((await get(app, { "x-user": "ada" })).status).toBe(403);
    expect(await (await held(app, { "x-user": "ada" })).json()).toEqual({ held: [] });
  });

  test("holds nothing before D1 is looked at, so an unbound DB is still a denial and never a 500", async () => {
    // The order inside `list()` is the assertion. A request that resolves nobody has nothing to ask the
    // database, so it must never reach the binding check — an organization-billed Worker whose seam is
    // unwired should read as unentitled, not as broken.
    const app = makeApp({ seam: UNANSWERED, withDatabase: false });
    expect(await (await held(app, { "x-user": "ada" })).json()).toEqual({ held: [] });
    expect((await get(app, { "x-user": "ada" })).status).toBe(403);
  });

  test("a resolved subject with no database still reports the wiring fault", async () => {
    // The other half of that order: the binding check is not gone, it is second. A request that *could*
    // have read D1 and found none is a composition mistake, and it says so where an operator sees it.
    const app = makeApp({ seam: ORGANIZATION_BILLED, withDatabase: false });
    const response = await held(app, { "x-user": "ada", "x-org": "acme" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "core/internal" });
  });
});

describe("organization billing", () => {
  test("resolves the acting organization's entitlements, and never another organization's", async () => {
    await grant({ subject: ACME, entitlement: "pro", active: 1, expiresAt: null });
    const app = makeApp({ seam: ORGANIZATION_BILLED });
    // A member of acme holds what acme bought, whoever they are.
    expect((await get(app, { "x-user": "ada", "x-org": "acme" })).status).toBe(200);
    expect((await get(app, { "x-user": "grace", "x-org": "acme" })).status).toBe(200);
    // Somebody acting for a different company holds nothing of acme's.
    expect((await get(app, { "x-user": "ada", "x-org": "globex" })).status).toBe(403);
    // And a signed-in caller acting for nobody holds nothing at all.
    expect((await get(app, { "x-user": "ada" })).status).toBe(403);
  });

  test("a user row with the organization's own id does not open an organization's gate", async () => {
    // Both halves of the pair are compared, because nothing keeps the two id namespaces disjoint.
    await grant({
      subject: { subjectType: "user", subjectId: "acme" },
      entitlement: "pro",
      active: 1,
      expiresAt: null,
    });
    expect((await get(makeApp({ seam: ORGANIZATION_BILLED }), { "x-user": "ada", "x-org": "acme" })).status).toBe(403);
  });
});

describe("createPaymentsEntitlementResolver", () => {
  test("resolves one subject's entitlements, and names payments as the provider", async () => {
    await grant({ subject: ADA, entitlement: "pro", active: 1, expiresAt: null });
    const resolver = createPaymentsEntitlementResolver(paymentsDatabase(env.DB), ADA, () => new Date(T0));
    expect(resolver.provider).toBe("payments");
    expect((await resolver.list()).map((e: Entitlement) => [e.key, e.active])).toEqual([["pro", true]]);
  });

  test("it takes the pair, so an organization of the same id holds nothing of the user's", async () => {
    await grant({ subject: ADA, entitlement: "pro", active: 1, expiresAt: null });
    const db = paymentsDatabase(env.DB);
    const asOrganization = { subjectType: "organization", subjectId: "ada" } satisfies PaymentsSubject;
    expect(await createPaymentsEntitlementResolver(db, asOrganization, () => new Date(T0)).list()).toEqual([]);
  });

  test("the injected clock decides the recheck, so a grant lapses without any write", async () => {
    await grant({ subject: ACME, entitlement: "pro", active: 1, expiresAt: T0 + DAY });
    const db = paymentsDatabase(env.DB);
    expect((await createPaymentsEntitlementResolver(db, ACME, () => new Date(T0)).list())[0]?.active).toBe(true);
    expect((await createPaymentsEntitlementResolver(db, ACME, () => new Date(T0 + 2 * DAY)).list())[0]?.active).toBe(
      false,
    );
  });

  test("a subject nobody granted anything to holds nothing", async () => {
    await grant({ subject: ACME, entitlement: "pro", active: 1, expiresAt: null });
    expect(
      await createPaymentsEntitlementResolver(paymentsDatabase(env.DB), GLOBEX, () => new Date(T0)).list(),
    ).toEqual([]);
  });
});

describe("the holder it reports", () => {
  /**
   * Core's `EntitlementHolder`: display text and an audit dimension, and nothing a gate compares. It is what
   * lets a denial say *which* nothing happened — a company that bought nothing, or a caller acting for no
   * company at all — and what puts a tenant on the denial's audit row. See `core/src/entitlement/entitlement.ts`.
   */

  test("under organization billing the tenant is the organization, and the label is its encoded reference", async () => {
    const response = await makeApp({ seam: ORGANIZATION_BILLED }).request(
      "http://x/holder",
      { headers: { "x-user": "ada", "x-org": "acme" } },
      env,
    );

    expect(await response.json()).toEqual({ holder: { label: "organization:acme", tenant: "acme" } });
  });

  test("under per-person billing the tenant is null — the app has no such dimension to invent", async () => {
    // The holder is the actor, so a tenant here would echo `actorId`. `AuditEvent.tenant` says a
    // single-tenant app must not invent one, and null means *not tenant-scoped* rather than unknown.
    const response = await makeApp().request("http://x/holder", { headers: { "x-user": "ada" } }, env);

    expect(await response.json()).toEqual({ holder: { label: "user:ada", tenant: null } });
  });

  test("an unanswered seam reports no holder, which is a different fact from holding nothing", async () => {
    const response = await makeApp({ seam: UNANSWERED }).request(
      "http://x/holder",
      { headers: { "x-user": "ada" } },
      env,
    );

    expect(await response.json()).toEqual({ holder: null });
  });

  test("an anonymous caller reports no holder either", async () => {
    const response = await makeApp().request("http://x/holder", {}, env);

    expect(await response.json()).toEqual({ holder: null });
  });

  test("the label is the one spelling of a holder the whole capability uses", async () => {
    // `encodeSubjectReference`'s form, so the string in a denial's log line is the string the rails stamp
    // into a store and the string `pithy payments reconcile --subject` takes. An operator pastes it.
    expect(paymentsEntitlementHolder(ACME)).toEqual({ label: encodeSubjectReference(ACME), tenant: "acme" });
    expect(paymentsEntitlementHolder(ADA)).toEqual({ label: encodeSubjectReference(ADA), tenant: null });
  });

  test("the seam is asked once per request, however many times the resolver is read", async () => {
    // A denial reads both halves, and the adopter's resolver is usually a session read. Resolving twice
    // would double that cost on exactly the path that is already failing.
    let calls = 0;
    const counted: PaymentsSubjectSeam = {
      billingSubject: "organization",
      resolveSubject: async () => {
        calls += 1;
        return ACME;
      },
    };
    const app = new Hono<PithyHonoEnv>();
    app.onError(pithyErrorHandler);
    app.use("*", async (c, next) => {
      c.set("entitlements", noEntitlementProvider);
      c.set("emit", noopEmit);
      c.set("log", noopLogger);
      c.set("db", { app: paymentsDatabase(env.DB) });
      c.set("auth", { userId: "ada", sessionId: "s1", scopes: [] });
      await next();
    });
    installEntitlementResolver("app", counted)(app);
    app.get("/both", async (c) => {
      await c.var.entitlements.list();
      await c.var.entitlements.holder?.();
      await c.var.entitlements.list();
      return c.json({ calls });
    });

    expect(await (await app.request("http://x/both", {}, env)).json()).toEqual({ calls: 1 });
  });

  // The anti-comparison property — that the gate decides on `list()` alone and never on the holder — is
  // pinned in `core/src/entitlement/require.test.ts`, where the holder can be varied against a fixed list.
  // It deliberately has no twin here: this middleware derives `holder()` and `list()` from one memoized
  // subject, so varying the holder means varying the subject, and a test that did that would be asserting
  // about the subject while claiming to assert about the holder. It would stay green with `holder` deleted.
});
