// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import type { PaymentsSubject } from "../data/subject";
import { grantEntitlement } from "../entitlement/manual";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { payments_0003_webhook_targets } from "../migrations/0003_webhook_targets";
import {
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminOverridesResponse,
  PaymentsAdminSubjectEntitlementsResponse,
  PaymentsOverrideResponse,
} from "./responses";
import { registerPaymentsRoutes } from "./routes";
import {
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_OVERRIDE_CLEAR_SCOPE,
  PAYMENTS_OVERRIDE_SET_SCOPE,
  PAYMENTS_OVERRIDE_UNRESTRICTED_SCOPE,
} from "./scopes";

/**
 * The override surface, executed — real D1, the real control-plane seam, a real Ed25519 token minted over the
 * exact body each request sends. The set, the unrestricted toggle and the clear, and the reads that show what
 * they did.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONNECTION_ID = "0b6f3c1a-2d4e-4f5a-8b9c-7d6e5f4a3b2c";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";
const ACME: PaymentsSubject = { subjectType: "organization", subjectId: "acme" };

/** The issue's catalog: growth bounded at 100,000 emails; scale with no ceiling; enterprise comp-only. */
const CONFIG = PaymentsConfig.parse({
  billingSubject: "organization",
  rails: { apple: true },
  entitlements: {
    growth: {
      name: "Growth",
      quotas: { emails: 5000, projects: 10, seats: 10 },
      features: { sso: true, auditExport: false },
      overrideMax: { emails: 100_000 },
    },
    scale: {
      name: "Scale",
      quotas: { emails: null, projects: null, seats: 50, apiCalls: 1_000_000 },
      features: { sso: true, auditExport: true },
    },
    enterprise: { name: "Enterprise", quotas: { emails: null, projects: null, seats: null } },
  },
  defaults: { quotas: { emails: 50, projects: 1, seats: 1 }, features: { sso: false, auditExport: false } },
  products: {
    growth_monthly: { type: "subscription", name: "Growth", entitlements: ["growth"], apple: { productId: "growth" } },
    scale_monthly: { type: "subscription", name: "Scale", entitlements: ["scale"], apple: { productId: "scale" } },
  },
});

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
    scopes: [...scopes],
    keys: [
      {
        keyId: KEY_ID,
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

/** Every override scope granted, unless a case narrows it. */
const ALL: readonly ControlPlaneScope[] = [
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_OVERRIDE_SET_SCOPE,
  PAYMENTS_OVERRIDE_CLEAR_SCOPE,
  PAYMENTS_OVERRIDE_UNRESTRICTED_SCOPE,
];

function makeApp(scopes: readonly ControlPlaneScope[] = ALL, config = CONFIG) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cp = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cp);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerPaymentsRoutes({ config, now: () => NOW })(app);
  return app;
}

/** One request with a token minted for `scope` over these exact bytes, or with none at all. */
async function send(
  app: Hono<PithyHonoEnv>,
  method: "GET" | "POST",
  path: string,
  scope: ControlPlaneScope | null,
  body?: unknown,
  connectionId = CONNECTION_ID,
): Promise<Response> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (scope !== null) {
    headers[CONTROL_PLANE_HEADER] = await mintControlPlaneToken({
      privateKey: keys.privateKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      connectionId,
      subject: "operator-1",
      scope,
      body: raw === undefined ? undefined : new TextEncoder().encode(raw),
      now: () => NOW,
    });
  }
  return app.request(`http://x${path}`, { method, headers, body: raw }, { ...env, ENVIRONMENT });
}

const set = (app: Hono<PithyHonoEnv>, body: unknown, scope: ControlPlaneScope = PAYMENTS_OVERRIDE_SET_SCOPE) =>
  send(app, "POST", "/payments/entitlements/overrides", scope, body);
const unrestricted = (
  app: Hono<PithyHonoEnv>,
  body: unknown,
  scope: ControlPlaneScope = PAYMENTS_OVERRIDE_UNRESTRICTED_SCOPE,
) => send(app, "POST", "/payments/entitlements/overrides/unrestricted", scope, body);
const clear = (app: Hono<PithyHonoEnv>, body: unknown) =>
  send(app, "POST", "/payments/entitlements/overrides/clear", PAYMENTS_OVERRIDE_CLEAR_SCOPE, body);

async function subjectRead(app: Hono<PithyHonoEnv>, subject: PaymentsSubject = ACME) {
  const response = await send(
    app,
    "GET",
    `/payments/admin/entitlements/${subject.subjectType}/${subject.subjectId}`,
    PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  );
  expect(response.status).toBe(200);
  return PaymentsAdminSubjectEntitlementsResponse.parse(await response.json());
}

const quotaOf = (read: Awaited<ReturnType<typeof subjectRead>>, name: string) =>
  read.allowances?.quotas.find((quota) => quota.name === name);

const errorOf = async (response: Response) =>
  (await response.json<{ error: { code: string; message: string } }>()).error;

/** Hold an entitlement key, the way the projection would. */
async function hold(subject: PaymentsSubject, key: string, active = 1) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_entitlements (id, subject_type, subject_id, entitlement, active, expires_at, source_purchase_id, manual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, null, 'p1', 0, 0, 0) ON CONFLICT (subject_type, subject_id, entitlement) DO UPDATE SET active = excluded.active",
  )
    .bind(crypto.randomUUID(), subject.subjectType, subject.subjectId, key, active)
    .run();
}

const pin = (version: number, quotas: Record<string, number | null>, reason = "Contract #4471") => ({
  ...ACME,
  version,
  reason,
  quotas,
});

beforeEach(async () => {
  for (const table of [
    "pithy_payments_purchases",
    "pithy_payments_entitlements",
    "pithy_payments_provider_accounts",
    "pithy_payments_webhook_events",
    "pithy_payments_reconcile_runs",
    "pithy_payments_sync_cursors",
    "pithy_payments_overrides",
    "pithy_payments_meter_counters",
    "pithy_payments_usage_reports",
    "pithy_payments_usage_runs",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await payments_0001_purchases.up(db);
  await payments_0002_allowances.up(db);
  await payments_0003_webhook_targets.up(db);
  emitted = [];
});

describe("POST /payments/entitlements/overrides — the set", () => {
  test("pins one name, and every other name keeps tracking the plan", async () => {
    await hold(ACME, "growth");
    const app = makeApp();
    const response = await set(app, pin(0, { emails: 20_000 }));
    expect(response.status).toBe(200);
    const body = PaymentsOverrideResponse.parse(await response.json());
    expect(body).toMatchObject({ ...ACME, version: 1, override: { quotas: { emails: 20_000 }, unrestricted: false } });

    const read = await subjectRead(app);
    expect(quotaOf(read, "emails")).toMatchObject({
      effective: 20_000,
      source: "override",
      // The plan's own number, beside the pin, so a pane can draw the row and offer to revert.
      inherited: 5000,
      inheritedSource: "plan",
      inheritedKey: "growth",
      overrideMax: 100_000,
    });
    expect(quotaOf(read, "projects")).toMatchObject({ effective: 10, source: "plan", key: "growth" });
    expect(read.overrideVersion).toBe(1);
  });

  test("a set is a merge: a request pinning one name leaves every other pin untouched", async () => {
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000 }));
    await set(app, { ...ACME, version: 1, reason: "Goodwill", features: { auditExport: true } });
    await set(app, pin(2, { seats: 25 }));
    const read = await subjectRead(app);
    expect(read.override).toMatchObject({ quotas: { emails: 20_000, seats: 25 }, features: { auditExport: true } });
    expect(read.overrideVersion).toBe(3);
  });

  test("a stale version is refused with payments/override_stale at 409, and writes nothing", async () => {
    // Two operators open the same subject at version 0, both edit `emails`.
    const app = makeApp();
    const first = await set(app, pin(0, { emails: 20_000 }, "Operator one"));
    expect(first.status).toBe(200);
    const second = await set(app, pin(0, { emails: 30_000 }, "Operator two"));
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe("payments/override_stale");
    const read = await subjectRead(app);
    expect(read.override).toMatchObject({ quotas: { emails: 20_000 }, reason: "Operator one", version: 1 });
  });

  test("a set returning the current version succeeds, and the version advances", async () => {
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000 }));
    const next = PaymentsOverrideResponse.parse(await (await set(app, pin(1, { emails: 21_000 }))).json());
    expect(next.version).toBe(2);
  });

  test("a set with no reason is a 400, and the audit event carries the reason verbatim", async () => {
    const app = makeApp();
    const missing = await set(app, { ...ACME, version: 0, quotas: { emails: 20_000 } });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("validation/invalid_input");

    await set(app, pin(0, { emails: 20_000 }, "Signed MSA, 2026-06-01, ticket 4471"));
    const event = emitted.find((e) => e.action === "payments/override_set");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    expect(event?.metadata).toMatchObject({
      subjectType: "organization",
      subjectId: "acme",
      mode: "patch",
      reason: "Signed MSA, 2026-06-01, ticket 4471",
      before: null,
      after: { quotas: { emails: 20_000 }, version: 1 },
    });
  });

  test("a set past a declared overrideMax is a 400 naming the limit — never clamped", async () => {
    await hold(ACME, "growth");
    const app = makeApp();
    const response = await set(app, pin(0, { emails: 200_000_000 }));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("100000");
    expect((await subjectRead(app)).override).toBeNull();
  });

  test("a name with no declared ceiling accepts any whole number", async () => {
    await hold(ACME, "scale");
    const response = await set(makeApp(), pin(0, { seats: 9_999_999 }));
    expect(response.status).toBe(200);
  });

  test("a quota that is not a whole number from 0 or null is a 400 through the validator", async () => {
    for (const bad of [2.5, -1, "20000"]) {
      const response = await set(makeApp(), pin(0, { emails: bad as unknown as number }));
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation/invalid_input");
    }
  });

  test("a name the declarations do not mention is a 400 naming it and listing what is declared", async () => {
    const response = await set(makeApp(), pin(0, { emals: 10 }));
    expect(response.status).toBe(400);
    const message = (await errorOf(response)).message;
    expect(message).toContain('"emals"');
    expect(message).toContain("emails");
  });

  test("a set body carrying unrestricted is refused, never quietly dropped", async () => {
    const response = await set(makeApp(), { ...pin(0, { emails: 10 }), unrestricted: true });
    expect(response.status).toBe(400);
    expect((await subjectRead(makeApp())).override).toBeNull();
  });

  test("a subject kind this project does not bill is refused exactly as a grant refuses it", async () => {
    const response = await set(makeApp(), { ...pin(0, { emails: 10 }), subjectType: "user" });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("This project bills organizations");
  });

  test("an unverified caller learns nothing about its body — the validator is behind the guard", async () => {
    const response = await set(makeApp(), { nonsense: true }, null as unknown as ControlPlaneScope);
    expect(response.status).toBe(401);
  });

  test("a credential for a connection this Worker does not administer is refused", async () => {
    const stranger = await send(
      makeApp(),
      "POST",
      "/payments/entitlements/overrides",
      PAYMENTS_OVERRIDE_SET_SCOPE,
      pin(0, { emails: 10 }),
      "11111111-2222-4333-8444-555555555555",
    );
    expect(stranger.status).toBe(401);
    expect((await subjectRead(makeApp())).override).toBeNull();
  });
});

describe("POST /payments/entitlements/overrides/unrestricted", () => {
  test("needs its own scope — a credential that may set a number is refused", async () => {
    const app = makeApp([PAYMENTS_OVERRIDE_SET_SCOPE, PAYMENTS_ENTITLEMENTS_READ_SCOPE]);
    const body = { ...ACME, version: 0, reason: "Ourselves", unrestricted: true };
    const withSetToken = await unrestricted(app, body, PAYMENTS_OVERRIDE_SET_SCOPE);
    expect(withSetToken.status).toBe(403);
    const withOwnToken = await unrestricted(app, body);
    expect(withOwnToken.status).toBe(403);
    expect((await errorOf(withOwnToken)).code).toBe("controlplane/insufficient_scope");
  });

  test("grants every quota unlimited and every feature on, and is visible on every read", async () => {
    await hold(ACME, "growth");
    const app = makeApp();
    const response = await unrestricted(app, {
      ...ACME,
      version: 0,
      reason: "Enterprise contract",
      unrestricted: true,
    });
    expect(response.status).toBe(200);
    const read = await subjectRead(app);
    expect(read.unrestricted).toBe(true);
    expect(read.allowances?.quotas.every((quota) => quota.effective === null && quota.source === "unrestricted")).toBe(
      true,
    );
    expect(read.allowances?.features.every((feature) => feature.effective === true)).toBe(true);
    // Including a name the subject's own tier never declared.
    expect(quotaOf(read, "apiCalls")).toMatchObject({ effective: null, inherited: 0, inheritedSource: "none" });

    const listing = PaymentsAdminEntitlementsResponse.parse(
      await (await send(app, "GET", "/payments/admin/entitlements", PAYMENTS_ENTITLEMENTS_READ_SCOPE)).json(),
    );
    expect(listing.entitlements.map((row) => row.unrestricted)).toEqual([true]);

    const overrides = PaymentsAdminOverridesResponse.parse(
      await (
        await send(app, "GET", "/payments/admin/overrides?unrestricted=true", PAYMENTS_ENTITLEMENTS_READ_SCOPE)
      ).json(),
    );
    expect(overrides.overrides.map((row) => `${row.subjectType}:${row.subjectId}`)).toEqual(["organization:acme"]);
  });

  test("is not bounded by overrideMax — being unbounded is its point", async () => {
    await hold(ACME, "growth");
    const app = makeApp();
    await unrestricted(app, { ...ACME, version: 0, reason: "Enterprise contract", unrestricted: true });
    expect(quotaOf(await subjectRead(app), "emails")).toMatchObject({ effective: null, overrideMax: 100_000 });
  });

  test("with a patch beside it, the patched names are pinned and the rest are unlimited", async () => {
    const app = makeApp();
    await unrestricted(app, { ...ACME, version: 0, reason: "Enterprise contract", unrestricted: true });
    await set(app, pin(1, { emails: 20_000 }));
    const read = await subjectRead(app);
    expect(quotaOf(read, "emails")).toMatchObject({ effective: 20_000, source: "override" });
    expect(quotaOf(read, "seats")).toMatchObject({ effective: null, source: "unrestricted" });
  });

  test("an override grants no key — an unrestricted subject holding nothing still holds nothing", async () => {
    const app = makeApp();
    await unrestricted(app, { ...ACME, version: 0, reason: "Enterprise contract", unrestricted: true });
    const read = await subjectRead(app);
    expect(read.entitlements).toEqual([]);
  });

  test("audits the mode, and the before and the after", async () => {
    const app = makeApp();
    await unrestricted(app, { ...ACME, version: 0, reason: "Ourselves", unrestricted: true });
    const event = emitted.find((e) => e.action === "payments/override_set");
    expect(event?.metadata).toMatchObject({ mode: "unrestricted", reason: "Ourselves", after: { unrestricted: true } });
  });
});

describe("POST /payments/entitlements/overrides/clear", () => {
  test("clearing an override that does not exist is idempotent and answers 200", async () => {
    const response = await clear(makeApp(), { ...ACME });
    expect(response.status).toBe(200);
    expect(PaymentsOverrideResponse.parse(await response.json())).toEqual({ ...ACME, override: null, version: 0 });
    expect(emitted.some((e) => e.action === "payments/override_cleared")).toBe(false);
  });

  test("unpins one name without disturbing the others, and the name resolves from the plan again", async () => {
    await hold(ACME, "growth");
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000, seats: 25 }));
    const response = await clear(app, { ...ACME, version: 1, quotas: ["emails"], reason: "Contract ended" });
    expect(response.status).toBe(200);
    const read = await subjectRead(app);
    expect(read.override?.quotas).toEqual({ seats: 25 });
    expect(quotaOf(read, "emails")).toMatchObject({ effective: 5000, source: "plan" });
    expect(quotaOf(read, "seats")).toMatchObject({ effective: 25, source: "override" });
    const event = emitted.find((e) => e.action === "payments/override_cleared");
    expect(event?.metadata).toMatchObject({ mode: "clear", reason: "Contract ended" });
  });

  test("a clear naming nothing removes the whole override", async () => {
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000 }));
    await clear(app, { ...ACME, version: 1 });
    expect((await subjectRead(app)).override).toBeNull();
  });

  test("a clear naming a stale version is refused", async () => {
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000 }));
    const response = await clear(app, { ...ACME, version: 7 });
    expect(response.status).toBe(409);
  });

  test("a version never repeats after a whole clear, so a writer holding the cleared row's version is refused", async () => {
    const app = makeApp();
    // A second operator's pane reads version 1 here, and keeps it.
    await set(app, pin(0, { emails: 20_000 }));
    const cleared = await clear(app, { ...ACME, version: 1 });
    expect(PaymentsOverrideResponse.parse(await cleared.json())).toEqual({ ...ACME, override: null, version: 2 });
    const read = await subjectRead(app);
    expect(read.override).toBeNull();
    expect(read.overrideVersion).toBe(2);
    expect((await set(app, pin(2, { emails: 30_000 }, "New contract"))).status).toBe(200);
    // The stale pane writes the name the newer contract pinned. Were the version reset by the clear, 1 would
    // be current again and the newer pin would be overwritten in silence.
    expect((await set(app, pin(1, { emails: 9_000 }))).status).toBe(409);
    expect((await set(app, pin(0, { emails: 9_000 }))).status).toBe(409);
    expect(quotaOf(await subjectRead(app), "emails")).toMatchObject({ effective: 30_000, source: "override" });
  });

  test("a cleared override is listed nowhere, and clearing it again changes nothing", async () => {
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000 }));
    await clear(app, { ...ACME, version: 1 });
    emitted = [];
    const again = await clear(app, { ...ACME });
    expect(PaymentsOverrideResponse.parse(await again.json())).toEqual({ ...ACME, override: null, version: 2 });
    expect(emitted.some((e) => e.action === "payments/override_cleared")).toBe(false);
    const listing = PaymentsAdminOverridesResponse.parse(
      await (await send(app, "GET", "/payments/admin/overrides", PAYMENTS_ENTITLEMENTS_READ_SCOPE)).json(),
    );
    expect(listing.overrides).toEqual([]);
  });

  test("a clear cannot lift a pinned name on an unrestricted subject to unlimited", async () => {
    // Unpinning on an unrestricted subject moves the name away from its plan, to unlimited. That is the
    // unrestricted scope's grant, and a credential holding only the clear scope must not be able to make it.
    const app = makeApp();
    await unrestricted(app, { ...ACME, version: 0, reason: "Enterprise contract", unrestricted: true });
    await set(app, pin(1, { emails: 20_000 }));
    await set(app, { ...ACME, version: 2, reason: "Contract #4471", features: { auditExport: false } });
    for (const names of [{ quotas: ["emails"] }, { features: ["auditExport"] }]) {
      const response = await clear(app, { ...ACME, ...names });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).toContain("unrestricted");
    }
    const read = await subjectRead(app);
    expect(quotaOf(read, "emails")).toMatchObject({ effective: 20_000, source: "override" });
    expect(read.override?.features).toEqual({ auditExport: false });
    expect(read.overrideVersion).toBe(3);
  });

  test("a whole clear of an unrestricted subject is allowed — it takes unrestricted with it, back to the plan", async () => {
    const app = makeApp();
    await unrestricted(app, { ...ACME, version: 0, reason: "Enterprise contract", unrestricted: true });
    expect((await clear(app, { ...ACME, version: 1 })).status).toBe(200);
    const read = await subjectRead(app);
    expect(read.unrestricted).toBe(false);
    expect(quotaOf(read, "emails")).toMatchObject({ effective: 50, source: "default" });
  });
});

describe("the subject read across a tier change", () => {
  test("a standing override survives an upgrade: every unmentioned name moved, and the pinned one did not", async () => {
    await hold(ACME, "growth");
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000 }));
    // The upgrade, as the projection writes it.
    await hold(ACME, "growth", 0);
    await hold(ACME, "scale");
    const read = await subjectRead(app);
    expect(quotaOf(read, "emails")).toMatchObject({ effective: 20_000, source: "override", inherited: null });
    expect(quotaOf(read, "projects")).toMatchObject({ effective: null, inherited: null, inheritedKey: "scale" });
    expect(quotaOf(read, "seats")).toMatchObject({ effective: 50, inherited: 50 });
    // Including a name the old tier never declared.
    expect(quotaOf(read, "apiCalls")).toMatchObject({ effective: 1_000_000, inheritedKey: "scale" });
  });

  test("an override and a manual grant compose: a comped key with a pinned quota resolves to both", async () => {
    await grantEntitlement(env.DB, CONFIG, { ...ACME, entitlement: "enterprise" }, { now: NOW });
    const app = makeApp();
    await set(app, pin(0, { emails: 20_000 }));
    const read = await subjectRead(app);
    expect(read.entitlements.map((row) => [row.key, row.manual])).toEqual([["enterprise", true]]);
    expect(quotaOf(read, "emails")).toMatchObject({ effective: 20_000 });
    expect(quotaOf(read, "seats")).toMatchObject({ effective: null, inheritedKey: "enterprise" });
  });
});
