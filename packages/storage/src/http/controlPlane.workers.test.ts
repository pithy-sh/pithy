// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { UsageResponse } from "@pithy-sh/core/src/access/usage";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { StorageConfig } from "../config/config";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, storageDatabase } from "../data/tables";
import { storage_0001_objects } from "../migrations/0001_objects";
import { storage_0002_ownership } from "../migrations/0002_ownership";
import { registerStorageRoutes } from "./routes";
import { STORAGE_USAGE_READ_SCOPE } from "./scopes";

/**
 * `GET /storage/admin/usage` — files and bytes per organization, and per owner within one. A per-owner
 * figure is always one organization's, so a report run for an organization cannot learn that one of its
 * users holds an account in another — not from a row, and not from a total that fails to reconcile.
 */

const NOW = new Date("2026-10-16T12:00:00.000Z");
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";

let keys: CryptoKeyPair;

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

/** The storage routes with a live control-plane verifier — and a permission hook that allows everything. */
function makeApp(scopes: readonly ControlPlaneScope[] = [STORAGE_USAGE_READ_SCOPE]) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("log", noopLogger);
    await next();
  });
  registerStorageRoutes({ config: StorageConfig.parse({}), permission: () => "allow" })(app);
  return app;
}

async function usage(query: string, scope: ControlPlaneScope = STORAGE_USAGE_READ_SCOPE, app = makeApp()) {
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
    `http://x/storage/admin/usage?${query}`,
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    { ...env, ENVIRONMENT },
  );
}

let sequence = 0;

/** Store one file of `size` bytes for an owner, in an organization. */
async function stored(ownerId: string, organizationId: string | null, size: number): Promise<void> {
  sequence += 1;
  const id = `3f2504e0-4f89-41d3-9a0c-0305e82c${String(sequence).padStart(4, "0")}`;
  await storageDatabase(env.DB)
    .insertInto(STORAGE_OBJECTS_TABLE)
    .values(
      StorageObject.encode({
        id,
        key: `obj/${id}`,
        path: `${id}.bin`,
        ownerId,
        organizationId,
        contentType: "application/octet-stream",
        size,
        visibility: "private",
        checksum: null,
        status: "stored",
        uploadId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    .execute();
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_shares");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_objects");
  const db = storageDatabase(env.DB) as unknown as Kysely<unknown>;
  await storage_0001_objects.up(db);
  await storage_0002_ownership.up(db);
  // One person in two organizations — the case the non-disclosure rule exists for.
  await stored("shared", "org-a", 100);
  await stored("shared", "org-a", 50);
  await stored("local", "org-a", 30);
  await stored("shared", "org-b", 7000);
});

describe("GET /storage/admin/usage", () => {
  test("answers bytes and counts per organization", async () => {
    const res = await usage("groupBy=organization");
    expect(res.status).toBe(200);
    const body = UsageResponse.parse(await res.json());
    expect(body.rows).toEqual([
      { organizationId: "org-b", records: 1, bytes: 7000 },
      { organizationId: "org-a", records: 3, bytes: 180 },
    ]);
  });

  test("answers bytes and counts per owner, within the organization named", async () => {
    const body = UsageResponse.parse(await (await usage("groupBy=owner&organizationId=org-a")).json());
    expect(body.rows).toEqual([
      { organizationId: "org-a", ownerId: "shared", records: 2, bytes: 150 },
      { organizationId: "org-a", ownerId: "local", records: 1, bytes: 30 },
    ]);
  });

  test("an organization cannot learn its user holds an account elsewhere — no row, and no total that fails to reconcile", async () => {
    const forUser = UsageResponse.parse(
      await (await usage("groupBy=owner&organizationId=org-a&ownerId=shared")).json(),
    );
    expect(forUser.rows).toEqual([{ organizationId: "org-a", ownerId: "shared", records: 2, bytes: 150 }]);

    const owners = UsageResponse.parse(await (await usage("groupBy=owner&organizationId=org-a")).json());
    const organization = UsageResponse.parse(await (await usage("groupBy=organization&organizationId=org-a")).json());
    expect(owners.rows.reduce((sum, row) => sum + row.bytes, 0)).toBe(organization.rows[0]?.bytes);
    expect(JSON.stringify(owners)).not.toContain("7000");
  });

  test("there is no way to ask for an unscoped per-owner read", async () => {
    for (const query of ["groupBy=owner", "groupBy=organization&ownerId=shared"]) {
      const res = await usage(query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation/invalid_input");
    }
  });

  test("a permission hook that allows everything does not widen it", async () => {
    // `makeApp` composes the storage routes with `permission: () => "allow"`; the rollup never asks it.
    const body = UsageResponse.parse(await (await usage("groupBy=owner&organizationId=org-b")).json());
    expect(body.rows).toEqual([{ organizationId: "org-b", ownerId: "shared", records: 1, bytes: 7000 }]);
  });

  test("a connection without the scope is refused", async () => {
    const res = await usage("groupBy=organization", STORAGE_USAGE_READ_SCOPE, makeApp([]));
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
  });
});
