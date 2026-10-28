// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { AuditEventInput } from "./audit/auditEvent";
import { defineCapability } from "./capability/capability";
import { ControlPlaneAuditActions } from "./controlPlane/audit/actions";
import { controlplane } from "./controlPlane/capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "./controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "./controlPlane/data/tables";
import { requireControlPlane } from "./controlPlane/http/guard";
import { controlplane_0001_init } from "./controlPlane/migrations/0001_init";
import { controlplane_0002_management_origin } from "./controlPlane/migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "./controlPlane/migrations/0003_connection_principal";
import { MANIFEST_READ_SCOPE } from "./controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "./controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "./controlPlane/wire";
import { createBackend } from "./createBackend";
import { createDatabase } from "./data/db";
import { InternalError, RateLimitError } from "./error/pithyError";

/**
 * A Worker in a bad state still answers its control plane.
 *
 * The fixture is `@pithy-sh/vector`'s `provisionGuard` in miniature: a readiness guard that refuses every
 * request it sees. Composed **first**, which is the order that used to take the seam down — a capability's
 * `app.use("*")` ran ahead of every control-plane route, so a drifted index answered `ping` with a 500 and
 * a management client could not tell drift from a Worker that is down.
 *
 * Everything else the seam stands on is in place and is asserted: the verifier, the audit trail, and a
 * route-protecting refusal like auth's rate limit, which is middleware and keeps running here.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://app.pithy.sh";
const CONNECTION_ID = "0b8c7d1e-4f2a-4e6b-9c3d-5a6b7c8d9e0f";
const BINDINGS = { ...env, ENVIRONMENT };

const DRIFT_MESSAGE = "This Worker's vector index disagrees with its config.";

/** Refuses every request — the shape of a misprovisioned index. */
const drifted = defineCapability({
  name: "drifted",
  requiredBindings: [],
  readiness: [
    () => {
      throw new InternalError({ message: DRIFT_MESSAGE, detail: "fixture" });
    },
  ],
});

/** `audit()`'s middleware in miniature: replace the no-op `emit` with a recorder. Composed after the guard. */
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

const INVENTORY_READ_SCOPE = "inventory:things:read";

/**
 * A capability with its own admin route, and a rate limit over it — auth's shape, scoped to its path. Its
 * public route is not admin surface, so the guard answers it.
 */
let limited = false;
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
  ],
  middleware: [
    (app) => {
      app.use("/inventory/*", async (_c, next) => {
        if (limited) throw new RateLimitError();
        await next();
      });
    },
  ],
  routes: (app) => {
    app.get("/inventory/admin/things", requireControlPlane(INVENTORY_READ_SCOPE), (c) => c.json({ things: [] }));
    app.get("/inventory/things", (c) => c.json({ things: [] }));
  },
});

/** The adopter's own API. Not an admin surface, so the guard answers it. */
const adopterApp = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: (app) => {
    app.get("/api/things", (c) => c.json({ things: [] }));
  },
});

const backend = createBackend({ capabilities: [drifted, controlplane(), recorder, inventory], app: adopterApp });

interface Signer {
  keyId: string;
  privateKey: CryptoKey;
  publicKey: Ed25519PublicJwk;
}

let alice: Signer;

async function connect(scopes: string[]) {
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: "https://api.acme.example",
        basePath: "/control-plane",
        managementOrigin: null,
        authorizedBy: "ada@example.com",
        actorKind: "dashboard",
        purpose: "The hosted dashboard.",
        scopes,
        keys: [
          {
            keyId: alice.keyId,
            publicKey: alice.publicKey,
            validFrom: new Date(Date.now() - 60_000),
            validUntil: null,
            revokedAt: null,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }),
    )
    .execute();
}

async function call(path: string, scope?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (scope !== undefined) {
    headers[CONTROL_PLANE_HEADER] = await mintControlPlaneToken({
      privateKey: alice.privateKey,
      keyId: alice.keyId,
      issuer: ISSUER,
      connectionId: CONNECTION_ID,
      subject: "usr_operator",
      scope,
    });
  }
  return backend.request(`http://worker.example${path}`, { method: "GET", headers }, BINDINGS);
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  await controlplane_0002_management_origin.up(db);
  await controlplane_0003_connection_principal.up(db);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  alice = { keyId: "cpk_alice", privateKey: pair.privateKey, publicKey: await exportPublicJwk(pair.publicKey) };
  await connect([MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE]);
  recorded.length = 0;
  limited = false;
});

describe("a Worker whose readiness guard refuses everything", () => {
  test("still answers ping with a valid credential", async () => {
    const response = await call("/control-plane/ping", MANIFEST_READ_SCOPE);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", connectionId: CONNECTION_ID });
  });

  test("still answers the manifest", async () => {
    const response = await call("/control-plane/manifest", MANIFEST_READ_SCOPE);
    expect(response.status).toBe(200);
    const names = ((await response.json()) as { capabilities: { name: string }[] }).capabilities.map((c) => c.name);
    expect(names).toContain("drifted");
  });

  test("still answers a capability's own admin route", async () => {
    const response = await call("/inventory/admin/things", INVENTORY_READ_SCOPE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ things: [] });
  });

  test("answers every other route with the guard's error", async () => {
    const response = await call("/api/things");
    expect(response.status).toBe(500);
    expect(await errorOf(response)).toMatchObject({ code: "core/internal", message: DRIFT_MESSAGE });
  });

  test("still audits an allowed call, through the emit a later capability published", async () => {
    await call("/control-plane/ping", MANIFEST_READ_SCOPE);
    expect(recorded.map((event) => event.action)).toEqual([ControlPlaneAuditActions.callAllowed]);
  });

  test("and a refused one", async () => {
    const response = await call("/control-plane/manifest");
    expect(response.status).toBe(401);
    expect(recorded.map((event) => event.action)).toEqual([ControlPlaneAuditActions.callDenied]);
  });

  test("keeps a rate limit on the admin surface, because that is middleware and not readiness", async () => {
    limited = true;
    const response = await call("/inventory/admin/things", INVENTORY_READ_SCOPE);
    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe("rate_limit/exceeded");
  });
});

describe("where a readiness guard mounts", () => {
  test("after every capability's middleware, so it reads what a later capability published", async () => {
    // The guard is composed first and the recorder after it. Registered in the middleware loop, the guard
    // would run before `emit` existed.
    let sawRecorder = false;
    const observer = defineCapability({
      name: "observer",
      requiredBindings: [],
      readiness: [
        async (c, next) => {
          await c.var.emit({ action: "observer/looked", outcome: "success" } as AuditEventInput);
          sawRecorder = recorded.length === 1;
          await next();
        },
      ],
    });
    const app = createBackend({ capabilities: [observer, recorder], app: adopterApp });
    await app.request("http://worker.example/api/things", { method: "GET" }, BINDINGS);
    expect(sawRecorder).toBe(true);
  });

  test("before any capability's routes, so it guards a route composed ahead of it", async () => {
    // Inventory is composed ahead of the guard, so its public route mounts first. Mounted with the guard's
    // own capability's routes, the guard would sit behind that route and never see the request.
    const app = createBackend({ capabilities: [controlplane(), inventory, drifted], app: adopterApp });
    const response = await app.request("http://worker.example/inventory/things", { method: "GET" }, BINDINGS);
    expect(response.status).toBe(500);
    expect(await errorOf(response)).toMatchObject({ code: "core/internal", message: DRIFT_MESSAGE });
  });

  test("never ahead of /health, which answers without reaching it", async () => {
    expect((await backend.request("http://worker.example/health", { method: "GET" }, BINDINGS)).status).toBe(200);
  });
});
