// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AuditEventInput } from "../../audit/auditEvent";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { type MintedKey, mintKey, signToken } from "../../test-utils/oidcFixtures";
import { controlplane } from "../capability";
import { ControlPlaneConnection } from "../data/connection";
import type { OidcTrust } from "../data/oidcTrust";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { ControlPlaneInsufficientScopeError } from "../error/errors";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { controlplane_0004_connection_trusts } from "../migrations/0004_connection_trusts";
import { MANIFEST_READ_SCOPE } from "../scope/scope";
import { CONTROL_PLANE_OIDC_HEADER, CONTROL_PLANE_SCOPE_HEADER, CONTROL_PLANE_TRUST_HEADER } from "../wire";
import { requireControlPlane } from "./guard";

/**
 * A call under an OIDC trust, end to end through the real `controlplane()` capability: real D1, the
 * capability's own verifier wiring, its isolate-wide key cache, and its first-call write.
 *
 * `verifyTrust.test.ts` owns the decision and `guardTrust.test.ts` the rows, both over a verifier built by hand.
 * This file is what proves the capability builds that verifier the same way — the connection loaded by this
 * environment, the first call stamped on the row it belongs to. Without it, deleting the trust half of the
 * capability's wiring would refuse every OIDC call on a deployed Worker and leave the suite green.
 *
 * The one thing faked is the identity provider: the issuer's key set is served from a stubbed `fetch`, because the
 * Worker fetching GitHub's keys is the point and GitHub is not in the test.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const AUDIENCE = "https://api.acme.example";
const CONNECTION_ID = "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b";
const TRUST_ID = "4b8f0c1e-2a7d-4e0b-9c55-0f3a6d2e7b19";
const SUBJECT = "repo:acme/api:environment:prod";
const INVENTORY_READ_SCOPE = "inventory:things:read";
const BINDINGS = { ...env, ENVIRONMENT };
const epoch = (at: Date) => Math.floor(at.getTime() / 1000);

/** `audit()`'s middleware in miniature: the no-op `emit` replaced with a recorder. */
const recorded: AuditEventInput[] = [];
const recorder = defineCapability({
  name: "recorder",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        c.set("emit", async (event: AuditEventInput) => {
          recorded.push(event);
        });
        await next();
      });
    },
  ],
});

/** A capability's own admin route, which is what a workload calls. */
const inventory = defineCapability({
  name: "inventory",
  requiredBindings: [],
  adminRoutes: [
    {
      method: "GET",
      path: "/inventory/admin/things",
      scope: INVENTORY_READ_SCOPE,
      kind: "reads",
      summary: "Every pending thing.",
    },
    {
      method: "GET",
      path: "/inventory/admin/vault",
      scope: INVENTORY_READ_SCOPE,
      kind: "reads",
      summary: "A route whose handler refuses past the gate.",
    },
  ],
  routes: (app) => {
    app.get("/inventory/admin/things", requireControlPlane(INVENTORY_READ_SCOPE), (c) => c.json({ things: [] }));
    app.get("/inventory/admin/vault", requireControlPlane(INVENTORY_READ_SCOPE), () => {
      throw new ControlPlaneInsufficientScopeError();
    });
  },
});

const backend = createBackend({ capabilities: [controlplane(), recorder, inventory] });

let key: MintedKey;
let jwksFetches = 0;

beforeAll(async () => {
  key = await mintKey("gh-1");
});

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  await controlplane_0002_management_origin.up(db);
  await controlplane_0003_connection_principal.up(db);
  await controlplane_0004_connection_trusts.up(db);
  recorded.length = 0;
  jwksFetches = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== JWKS_URL) return new Response("not found", { status: 404 });
    jwksFetches += 1;
    return new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Register a connection holding one trust and no key — what `pithy dashboard connect --oidc-issuer` writes. */
async function connect(overrides: Partial<OidcTrust> = {}): Promise<void> {
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: AUDIENCE,
        basePath: "/control-plane",
        managementOrigin: null,
        authorizedBy: "ada@example.com",
        actorKind: "agent",
        purpose: "Nightly audit summarizer.",
        scopes: [MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE],
        keys: [],
        trusts: [
          {
            trustId: TRUST_ID,
            issuer: ISSUER,
            jwksUrl: JWKS_URL,
            audience: AUDIENCE,
            claims: { repository_id: "1262274726", environment: "prod" },
            authorizedBy: "ada@example.com",
            validFrom: new Date(now.getTime() - 60_000),
            revokedAt: null,
            firstCallAt: null,
            ...overrides,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }),
    )
    .execute();
}

async function storedTrust(): Promise<OidcTrust | undefined> {
  const row = await controlPlaneDatabase(env.DB)
    .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
    .selectAll()
    .where("id", "=", CONNECTION_ID)
    .executeTakeFirstOrThrow();
  return ControlPlaneConnection.parse(row).trusts?.[0];
}

/** Call an admin route as the workload would: its OIDC token, the trust it names, and the scope it needs. */
async function call(path: string, claims: Record<string, unknown> = {}, scope = INVENTORY_READ_SCOPE) {
  const now = new Date();
  const token = await signToken(
    {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: SUBJECT,
      exp: epoch(now) + 300,
      iat: epoch(now) - 30,
      repository_id: "1262274726",
      environment: "prod",
      ...claims,
    },
    key,
  );
  return backend.request(
    `http://worker.example${path}`,
    {
      headers: {
        [CONTROL_PLANE_OIDC_HEADER]: token,
        [CONTROL_PLANE_TRUST_HEADER]: TRUST_ID,
        [CONTROL_PLANE_SCOPE_HEADER]: scope,
      },
    },
    BINDINGS,
  );
}

describe("a call under an OIDC trust, through the composed capability", () => {
  test("is allowed on a granted route, recorded as the trust's, and stamps the trust's first call", async () => {
    await connect();
    expect((await storedTrust())?.firstCallAt).toBeNull();

    const response = await call("/inventory/admin/things");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ things: [] });
    // The Worker fetched the issuer's keys from the trust's own jwksUrl.
    expect(jwksFetches).toBeGreaterThan(0);

    const allowed = recorded.find((event) => event.action === "controlplane/call_allowed");
    expect(allowed).toMatchObject({
      actorId: SUBJECT,
      resourceId: CONNECTION_ID,
      metadata: { keyId: TRUST_ID, credentialKind: "trust", scope: INVENTORY_READ_SCOPE },
    });
    // The listing stops saying awaiting a first call, because the row in D1 now says when it came.
    expect((await storedTrust())?.firstCallAt).toBeInstanceOf(Date);
  });

  test("a token whose claims do not match the trust is refused, recording what it carried", async () => {
    await connect();

    const response = await call("/inventory/admin/things", { repository_id: "999" });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("controlplane/invalid_credential");

    const denied = recorded.find((event) => event.action === "controlplane/call_denied");
    expect(denied).toMatchObject({
      outcome: "denied",
      actorId: null,
      metadata: {
        reason: "controlplane/invalid_credential",
        connectionId: CONNECTION_ID,
        trustId: TRUST_ID,
        observedClaims: { sub: SUBJECT, repository_id: "999", environment: "prod" },
      },
    });
    // A refused call is not a first call.
    expect((await storedTrust())?.firstCallAt).toBeNull();
  });

  test("a scope the connection does not grant is refused like a key's", async () => {
    await connect();
    const response = await call("/inventory/admin/things", {}, "audit:events:read");
    expect(response.status).toBe(403);
    expect((await storedTrust())?.firstCallAt).toBeNull();

    // Recorded as the trust's refusal, so a read of the trust's reach filtered on its kind finds it beside its calls.
    const denied = recorded.find((event) => event.action === "controlplane/call_denied");
    expect(denied).toMatchObject({
      actorId: SUBJECT,
      resourceId: CONNECTION_ID,
      metadata: { reason: "controlplane/insufficient_scope", keyId: TRUST_ID, credentialKind: "trust" },
    });
  });

  test("a scope refusal its handler raises past the gate is recorded as the trust's", async () => {
    await connect();
    const response = await call("/inventory/admin/vault");
    expect(response.status).toBe(403);

    const denied = recorded.find((event) => event.action === "controlplane/call_denied");
    expect(denied).toMatchObject({
      actorId: SUBJECT,
      metadata: { refusedBy: "handler", keyId: TRUST_ID, credentialKind: "trust" },
    });
  });

  test("a revoked trust is refused from the next call", async () => {
    await connect({ revokedAt: new Date(Date.now() - 1_000) });
    expect((await call("/inventory/admin/things")).status).toBe(401);
  });

  test("a connection registered for another environment answers nothing here", async () => {
    await connect();
    await controlPlaneDatabase(env.DB)
      .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
      .set({ environment: "staging" })
      .where("id", "=", CONNECTION_ID)
      .execute();
    expect((await call("/inventory/admin/things")).status).not.toBe(200);
  });
});
