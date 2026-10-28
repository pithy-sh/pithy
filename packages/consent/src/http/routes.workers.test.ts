// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { type Capability, defineCapability, type PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ConsentGrant, ConsentWithdrawal } from "@pithy-sh/core/src/consent/reader";
import { composedConsent } from "@pithy-sh/core/src/consent/reader";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { ForbiddenError } from "@pithy-sh/core/src/error/pithyError";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CONSENT_MIGRATION_ORDER, consent } from "../capability";
import { CONSENT_VISITOR_COOKIE } from "../config/config";
import { documentHash } from "../evidence/evidence";
import { consent_0001_init } from "../migrations/0001_init";
import {
  ConsentAdminPurposesResponse,
  ConsentAdminSubjectResponse,
  ConsentChoiceResponse,
  ConsentPurposesResponse,
  MyConsentResponse,
} from "./responses";
import { CONSENT_READ_SCOPE } from "./scopes";

/**
 * The consent routes, actually served: real D1 and R2, a live control-plane verifier, a capturing audit seam, a
 * stand-in for auth that reads `x-user`, and a same-origin gate that refuses `x-cross-site`. What only survives
 * here: the device-id cookie set only after a choice, the merge at the first signed-in request, the CSRF gate on
 * both writes, a withdrawal reaching its purpose's owner, and every response against its schema.
 */

const NOW = new Date("2026-10-27T12:00:00.000Z");
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";
const DOCUMENT = "I authorize the clinic to keep my health record.";

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];
let withdrawals: { purpose: string; subject: string; address: string | null }[] = [];
let grants: { purpose: string; subject: string; address: string | null }[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "consent",
      order: CONSENT_MIGRATION_ORDER,
      migrations: { "0001_init": consent_0001_init },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

beforeEach(async () => {
  emitted = [];
  withdrawals = [];
  grants = [];
  for (const table of [
    "pithy_consent_records",
    "pithy_consent_documents",
    "pithy_consent_merges",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
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

/** A stand-in for email: it declares a purpose and hears its withdrawal and its grant. */
const email = defineCapability({
  name: "email",
  requiredBindings: [],
  consentPurposes: [
    {
      id: "email.marketing",
      summary: "Send me news and offers by email.",
      noticeVersion: 1,
      classes: ["pii"],
      explicit: false,
      minimumMethod: "click",
      writtenWithdrawal: false,
    },
  ],
  consentWithdrawn: async (withdrawal: ConsentWithdrawal) => {
    withdrawals.push({
      purpose: withdrawal.purpose,
      subject: `${withdrawal.subject.kind}:${withdrawal.subject.id}`,
      address: await withdrawal.address(),
    });
  },
  consentGranted: async (grant: ConsentGrant) => {
    grants.push({
      purpose: grant.purpose,
      subject: `${grant.subject.kind}:${grant.subject.id}`,
      address: await grant.address(),
    });
  },
});

/** A stand-in for auth's address seam. */
const auth = defineCapability({
  name: "auth",
  requiredBindings: [],
  addressOf: async (_env, userId) => `${userId}@example.com`,
});

/**
 * The composed app. The consent middleware is mounted **before** the identity stand-in, the hard order for the
 * merge: it must still see the identity set after it.
 */
function makeApp(granted: readonly ControlPlaneScope[] = [CONSENT_READ_SCOPE]) {
  const capability = consent({
    purposes: [
      {
        id: "clinic.records",
        summary: "Keep my health record.",
        noticeVersion: 2,
        classes: ["phi"],
        explicit: true,
        minimumMethod: "typed",
        writtenWithdrawal: true,
      },
    ],
  });
  const capabilities: Capability[] = [auth, email, capability];
  capability.compose?.({ capabilities });
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(granted);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    c.set("sameOrigin", async (gc, gnext) => {
      if (gc.req.header("x-cross-site")) throw new ForbiddenError({ message: "Cross-origin request rejected." });
      await gnext();
    });
    await next();
  });
  for (const middleware of capability.middleware ?? []) middleware(app);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    if (user) c.set("auth", { userId: user, sessionId: "s1", scopes: [] });
    await next();
  });
  capability.routes?.(app);
  return { app, capability, capabilities };
}

async function request(
  app: Hono<PithyHonoEnv>,
  method: "GET" | "POST",
  path: string,
  options: {
    body?: unknown;
    user?: string;
    cookie?: string;
    crossSite?: boolean;
    ip?: string;
    bindings?: Record<string, unknown>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.ip) headers["cf-connecting-ip"] = options.ip;
  if (options.user) headers["x-user"] = options.user;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.crossSite) headers["x-cross-site"] = "1";
  return app.request(
    `https://acme.example${path}`,
    { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) },
    { ...env, ...options.bindings },
  );
}

/** The device-id cookie a response set, as `name=value`, or null. */
function visitorCookie(response: Response): string | null {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${CONSENT_VISITOR_COOKIE}=([^;]*)`).exec(header);
  return match && match[1] !== "" ? `${CONSENT_VISITOR_COOKIE}=${match[1]}` : null;
}

const marketing = { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "banner" };

describe("the person's routes", () => {
  test("the purposes list the composed and the adopter's own", async () => {
    const { app } = makeApp();
    const response = await request(app, "GET", "/consent/purposes");
    const body = ConsentPurposesResponse.parse(await response.json());
    expect(body.purposes.map((purpose) => purpose.id)).toEqual(["email.marketing", "clinic.records"]);
  });

  test("the device-id cookie is set only once a choice is made", async () => {
    const { app } = makeApp();
    for (const path of ["/consent/purposes", "/consent/me"]) {
      expect(visitorCookie(await request(app, "GET", path)), path).toBeNull();
    }
    const me = MyConsentResponse.parse(await (await request(app, "GET", "/consent/me")).json());
    expect(me.subject).toBeNull();

    const granted = await request(app, "POST", "/consent/grants", { body: marketing });
    expect(granted.status).toBe(201);
    const cookie = visitorCookie(granted);
    expect(cookie).not.toBeNull();
    expect(granted.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(granted.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
    expect(granted.headers.get("set-cookie")).toMatch(/Secure/i);

    const mine = MyConsentResponse.parse(
      await (await request(app, "GET", "/consent/me", { cookie: cookie ?? "" })).json(),
    );
    expect(mine.subject?.kind).toBe("visitor");
    expect(mine.purposes.find((p) => p.purpose.id === "email.marketing")?.granted).toBe(true);
    expect(emitted.map((event) => event.action)).toEqual(["consent/granted"]);
    expect(emitted[0]?.actorType).toBe("anonymous");
  });

  test("declining is a choice too: a visitor's withdrawal is recorded and holds the cookie", async () => {
    const { app } = makeApp();
    const response = await request(app, "POST", "/consent/withdrawals", {
      body: { purpose: "email.marketing", method: "click", surface: "banner" },
    });
    expect(response.status).toBe(201);
    expect(visitorCookie(response)).not.toBeNull();
    const body = ConsentChoiceResponse.parse(await response.json());
    expect(body.standing).toBe("withdrawn");
  });

  test("a signed-in person reads and withdraws their own consent, and withdrawing is the same request as granting", async () => {
    const { app } = makeApp();
    const grant = await request(app, "POST", "/consent/grants", { user: "ada", body: marketing });
    expect(ConsentChoiceResponse.parse(await grant.json()).granted).toBe(true);
    expect(visitorCookie(grant)).toBeNull();
    const withdraw = await request(app, "POST", "/consent/withdrawals", {
      user: "ada",
      body: { purpose: "email.marketing", method: "click", surface: "settings" },
    });
    expect(ConsentChoiceResponse.parse(await withdraw.json()).granted).toBe(false);
    const me = MyConsentResponse.parse(await (await request(app, "GET", "/consent/me", { user: "ada" })).json());
    expect(me.records.map((record) => record.action)).toEqual(["grant", "withdraw"]);
    expect(emitted.map((event) => event.action)).toEqual(["consent/granted", "consent/withdrawn"]);
    expect(emitted[1]?.metadata).toMatchObject({ purpose: "email.marketing", method: "click" });
  });

  test("a withdrawal reaches the capability that owns the purpose, with the account's address", async () => {
    const { app } = makeApp();
    await request(app, "POST", "/consent/grants", { user: "ada", body: marketing });
    await request(app, "POST", "/consent/withdrawals", {
      user: "ada",
      body: { purpose: "email.marketing", method: "click", surface: "settings" },
    });
    expect(withdrawals).toEqual([{ purpose: "email.marketing", subject: "account:ada", address: "ada@example.com" }]);
  });

  test("a grant that stands reaches the capability that owns the purpose; a refused one reaches nothing", async () => {
    const { app } = makeApp();
    await request(app, "POST", "/consent/grants", { user: "ada", body: { ...marketing, noticeVersion: 9 } });
    expect(grants).toEqual([]);
    await request(app, "POST", "/consent/grants", { user: "ada", body: marketing });
    expect(grants).toEqual([{ purpose: "email.marketing", subject: "account:ada", address: "ada@example.com" }]);
  });

  test("a device-id cookie that is not a UUID is no visitor at all", async () => {
    const { app } = makeApp();
    const cookie = `${CONSENT_VISITOR_COOKIE}=not-a-uuid`;
    const me = MyConsentResponse.parse(await (await request(app, "GET", "/consent/me", { cookie })).json());
    expect(me.subject).toBeNull();

    const signedIn = await request(app, "GET", "/consent/purposes", { user: "ada", cookie });
    expect(signedIn.status).toBe(200);
    expect(emitted.map((event) => event.action)).not.toContain("consent/merged");
    const merges = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_consent_merges").first<{ n: number }>();
    expect(merges?.n).toBe(0);
  });

  test("both writes are rate-limited per address, under their own key, before anything is read or written", async () => {
    const { app } = makeApp();
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    };
    for (const path of ["/consent/grants", "/consent/withdrawals"]) {
      const response = await request(app, "POST", path, {
        body: marketing,
        ip: "203.0.113.9",
        bindings: { AUTH_RATE_LIMITER: limiter },
      });
      expect(response.status, path).toBe(429);
      expect(visitorCookie(response), path).toBeNull();
    }
    expect(keys).toEqual(["consent:203.0.113.9", "consent:203.0.113.9"]);
    expect(emitted).toEqual([]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_consent_records").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  test("both writes refuse a cross-site request before reading it", async () => {
    const { app } = makeApp();
    for (const path of ["/consent/grants", "/consent/withdrawals"]) {
      const response = await request(app, "POST", path, { body: marketing, crossSite: true });
      expect(response.status, path).toBe(403);
      expect(visitorCookie(response), path).toBeNull();
    }
    expect(emitted).toEqual([]);
  });

  test("a person reads back a document they signed, and never someone else's", async () => {
    const { app } = makeApp();
    await request(app, "POST", "/consent/grants", {
      user: "ada",
      body: {
        purpose: "clinic.records",
        noticeVersion: 2,
        method: "typed",
        surface: "intake",
        document: DOCUMENT,
        typedName: "Ada Lovelace",
      },
    });
    const hash = await documentHash(DOCUMENT);
    const own = await request(app, "GET", `/consent/me/documents/${hash}`, { user: "ada" });
    expect(own.status).toBe(200);
    expect(await own.text()).toBe(DOCUMENT);
    const other = await request(app, "GET", `/consent/me/documents/${hash}`, { user: "grace" });
    expect(other.status).toBe(404);
  });

  test("a stale notice and a method below the minimum are refused with their codes", async () => {
    const { app } = makeApp();
    const stale = await request(app, "POST", "/consent/grants", {
      user: "ada",
      body: { ...marketing, noticeVersion: 9 },
    });
    expect(stale.status).toBe(409);
    const below = await request(app, "POST", "/consent/grants", {
      user: "ada",
      body: { purpose: "clinic.records", noticeVersion: 2, method: "click", surface: "x" },
    });
    expect(((await below.json()) as { error: { code: string } }).error.code).toBe("consent/method_below_minimum");
  });
});

describe("the merge at sign-in", () => {
  test("the first signed-in request carrying a visitor's cookie merges it, records it, and lets the cookie go", async () => {
    const { app, capabilities } = makeApp();
    const granted = await request(app, "POST", "/consent/grants", { body: marketing });
    const cookie = visitorCookie(granted) ?? "";
    const signedIn = await request(app, "GET", "/consent/purposes", { user: "ada", cookie });
    // Cleared: an expired cookie of the same name.
    expect(signedIn.headers.get("set-cookie")).toMatch(new RegExp(`${CONSENT_VISITOR_COOKIE}=;`));
    expect(emitted.map((event) => event.action)).toEqual(["consent/granted", "consent/merged"]);
    const reader = composedConsent(capabilities, env as unknown as Record<string, unknown>);
    expect(await reader?.hasConsent({ kind: "account", id: "ada" }, "email.marketing")).toBe(true);

    // A retried sign-in with the same cookie records nothing new.
    await request(app, "GET", "/consent/purposes", { user: "ada", cookie });
    expect(emitted.filter((event) => event.action === "consent/merged")).toHaveLength(1);
    const merges = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_consent_merges").first<{ n: number }>();
    expect(merges?.n).toBe(1);
  });
});

/** One control-plane request carrying a token minted for `scope`. */
async function send(app: Hono<PithyHonoEnv>, path: string, scope: ControlPlaneScope): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    now: () => NOW,
  });
  return app.request(
    `https://acme.example${path}`,
    { headers: { [CONTROL_PLANE_HEADER]: token } },
    {
      ...env,
      ENVIRONMENT,
    },
  );
}

describe("the control plane", () => {
  test("counts per purpose and version, a subject's record, and the signed document, behind consent:read", async () => {
    const { app } = makeApp();
    await request(app, "POST", "/consent/grants", { user: "ada", body: marketing });
    await request(app, "POST", "/consent/grants", { user: "grace", body: marketing });
    await request(app, "POST", "/consent/withdrawals", {
      user: "grace",
      body: { purpose: "email.marketing", method: "click", surface: "settings" },
    });
    await request(app, "POST", "/consent/grants", {
      user: "ada",
      body: {
        purpose: "clinic.records",
        noticeVersion: 2,
        method: "typed",
        surface: "intake",
        document: DOCUMENT,
        typedName: "Ada Lovelace",
        representative: { name: "Byron", relationship: "parent" },
      },
    });

    const counts = ConsentAdminPurposesResponse.parse(
      await (await send(app, "/consent/control-plane/purposes", CONSENT_READ_SCOPE)).json(),
    );
    expect(counts.purposes.find((p) => p.purpose.id === "email.marketing")?.versions).toEqual([
      { noticeVersion: 1, grants: 1, withdrawals: 1 },
    ]);

    const subject = ConsentAdminSubjectResponse.parse(
      await (await send(app, "/consent/control-plane/subjects/account/ada", CONSENT_READ_SCOPE)).json(),
    );
    const signed = subject.records.find((record) => record.purpose === "clinic.records");
    expect(signed?.typedName).toBe("Ada Lovelace");
    expect(signed?.representative).toEqual({ name: "Byron", relationship: "parent" });

    const document = await send(app, `/consent/control-plane/documents/${signed?.documentHash}`, CONSENT_READ_SCOPE);
    expect(await document.text()).toBe(DOCUMENT);
  });

  test("a connection without consent:read is refused", async () => {
    const { app } = makeApp([]);
    const response = await send(app, "/consent/control-plane/purposes", CONSENT_READ_SCOPE);
    expect(response.status).toBe(403);
  });

  test("evidence is served as an attachment that will not render on this origin", async () => {
    const { app } = makeApp();
    await request(app, "POST", "/consent/grants", {
      user: "ada",
      body: {
        purpose: "clinic.records",
        noticeVersion: 2,
        method: "drawn",
        surface: "intake",
        document: DOCUMENT,
        drawn: { image: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>"), type: "image/svg+xml" },
      },
    });
    const subject = ConsentAdminSubjectResponse.parse(
      await (await send(app, "/consent/control-plane/subjects/account/ada", CONSENT_READ_SCOPE)).json(),
    );
    const hash = subject.records[0]?.drawnImageHash ?? "";
    const response = await send(app, `/consent/control-plane/evidence/${hash}`, CONSENT_READ_SCOPE);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
