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
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { controlplane_0004_connection_trusts } from "../migrations/0004_connection_trusts";
import { CONTROL_PLANE_OIDC_HEADER, CONTROL_PLANE_SCOPE_HEADER, CONTROL_PLANE_TRUST_HEADER } from "../wire";
import { requireControlPlane } from "./guard";

/**
 * A call under a trust is checked against the connection that holds the trust, not whichever row of the
 * environment SQLite returns first.
 *
 * `pithy dashboard connect` keeps one connection per environment, but nothing in the schema does: a seed, a hand
 * insert or an older database can hold several. Each test below inserts two connections in one environment, each
 * holding its own trust, and runs in both insert orders, because the order is exactly what the call must not depend
 * on. The project and the Worker are named differently, so nothing here passes by a name coinciding.
 */

const ENVIRONMENT = "prod";
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const AUDIENCE = "https://board.replay.example";
const SUBJECT = "repo:acme/replay:environment:prod";
const SCOPE = "inventory:things:read";
const BINDINGS = { ...env, PROJECT: "replay", WORKER: "board", ENVIRONMENT };
const epoch = (at: Date) => Math.floor(at.getTime() / 1000);

const AUDITOR = {
  connectionId: "1a2b3c4d-0000-4000-8000-00000000a001",
  trustId: "7c0e1f2a-0000-4000-8000-0000000a7001",
};
const RELEASER = {
  connectionId: "1a2b3c4d-0000-4000-8000-00000000b002",
  trustId: "7c0e1f2a-0000-4000-8000-0000000b7002",
};

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

const inventory = defineCapability({
  name: "inventory",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/inventory/admin/things", scope: SCOPE, kind: "reads", summary: "Every pending thing." },
  ],
  routes: (app) => {
    app.get("/inventory/admin/things", requireControlPlane(SCOPE), (c) => c.json({ things: [] }));
  },
});

const backend = createBackend({ capabilities: [controlplane(), recorder, inventory] });

let key: MintedKey;

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
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== JWKS_URL) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function trust(trustId: string, overrides: Partial<OidcTrust> = {}): OidcTrust {
  return {
    trustId,
    issuer: ISSUER,
    jwksUrl: JWKS_URL,
    audience: AUDIENCE,
    claims: { repository_id: "1262274726", environment: "prod" },
    authorizedBy: "ada@example.com",
    validFrom: new Date(Date.now() - 60_000),
    revokedAt: null,
    firstCallAt: null,
    ...overrides,
  };
}

/** Insert one connection in this environment holding the given trusts and no key. */
async function connect(connectionId: string, trusts: OidcTrust[]): Promise<void> {
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: connectionId,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: AUDIENCE,
        basePath: "/control-plane",
        managementOrigin: null,
        authorizedBy: "ada@example.com",
        actorKind: "agent",
        purpose: "Release automation.",
        scopes: [SCOPE],
        keys: [],
        trusts,
        createdAt: now,
        updatedAt: now,
      }),
    )
    .execute();
}

async function call(trustId: string | null) {
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
    },
    key,
  );
  const headers: Record<string, string> = { [CONTROL_PLANE_OIDC_HEADER]: token, [CONTROL_PLANE_SCOPE_HEADER]: SCOPE };
  if (trustId !== null) headers[CONTROL_PLANE_TRUST_HEADER] = trustId;
  return backend.request("http://worker.example/inventory/admin/things", { headers }, BINDINGS);
}

/** The connection the allowed call was recorded against. */
function allowedOn(): unknown {
  return recorded.find((event) => event.action === "controlplane/call_allowed")?.resourceId;
}

const ORDERS = [
  ["the auditor's connection first", [AUDITOR, RELEASER]],
  ["the releaser's connection first", [RELEASER, AUDITOR]],
] as const;

describe.each(ORDERS)("two connections in one environment, %s", (_, order) => {
  beforeEach(async () => {
    for (const held of order) await connect(held.connectionId, [trust(held.trustId)]);
  });

  test.each([
    ["auditor", AUDITOR],
    ["releaser", RELEASER],
  ])("a call under the %s's trust verifies against its own connection", async (_name, held) => {
    const response = await call(held.trustId);
    expect(response.status).toBe(200);
    expect(allowedOn()).toBe(held.connectionId);
  });

  test("a trust no connection holds is refused", async () => {
    const response = await call("7c0e1f2a-0000-4000-8000-0000000c7003");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("controlplane/invalid_credential");
  });

  test("a call naming no trust is refused", async () => {
    const response = await call(null);
    expect(response.status).not.toBe(200);
    expect(allowedOn()).toBeUndefined();
  });
});

describe.each(ORDERS)("one trust id on two connections, %s", (_, order) => {
  test("is refused as ambiguous", async () => {
    const shared = "7c0e1f2a-0000-4000-8000-0000000d7004";
    for (const held of order) await connect(held.connectionId, [trust(held.trustId), trust(shared)]);
    const response = await call(shared);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("controlplane/invalid_credential");
    expect(allowedOn()).toBeUndefined();
  });

  test("verifies against the one connection on which it is still live", async () => {
    const shared = "7c0e1f2a-0000-4000-8000-0000000d7004";
    const [first, second] = order;
    await connect(first.connectionId, [trust(shared, { revokedAt: new Date(Date.now() - 1_000) })]);
    await connect(second.connectionId, [trust(shared)]);
    const response = await call(shared);
    expect(response.status).toBe(200);
    expect(allowedOn()).toBe(second.connectionId);
  });
});

describe.each(ORDERS)("an unreadable connection row beside a healthy one, %s", (_, order) => {
  /** Overwrite one row's stored trusts with text no decoder accepts. */
  async function corrupt(connectionId: string, trusts: string): Promise<void> {
    await env.DB.prepare("UPDATE pithy_controlplane_connections SET trusts = ? WHERE id = ?")
      .bind(trusts, connectionId)
      .run();
  }

  test("does not stop a call under a trust the healthy row holds", async () => {
    const [broken, healthy] = order;
    for (const held of order) await connect(held.connectionId, [trust(held.trustId)]);
    await corrupt(broken.connectionId, "not json");
    const response = await call(healthy.trustId);
    expect(response.status).toBe(200);
    expect(allowedOn()).toBe(healthy.connectionId);
  });

  test("still refuses a call under a trust the unreadable row names", async () => {
    const [broken] = order;
    for (const held of order) await connect(held.connectionId, [trust(held.trustId)]);
    await corrupt(broken.connectionId, `[{"trustId":"${broken.trustId}"`);
    const response = await call(broken.trustId);
    expect(response.status).not.toBe(200);
    expect(allowedOn()).toBeUndefined();
  });
});

test("an environment holding no connection is not connected", async () => {
  const response = await call(AUDITOR.trustId);
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("controlplane/not_connected");
});
