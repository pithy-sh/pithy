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
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MediaConfig } from "../config/config";
import { extendMediaAsset } from "../data/extend";
import { caller, makeDeps, resetMediaTables } from "../test-utils/harness";
import { createMedia, finalizeMedia } from "./handlers";
import { registerMediaRoutes } from "./routes";
import { MEDIA_USAGE_READ_SCOPE } from "./scopes";

/**
 * `GET /media/admin/usage` — records and bytes per organization, and per owner within one. A per-owner
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

/** The media routes with a live control-plane verifier — and a permission hook that allows everything. */
function makeApp(scopes: readonly ControlPlaneScope[] = [MEDIA_USAGE_READ_SCOPE]) {
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
  registerMediaRoutes({ config: MediaConfig.parse({}), schema: extendMediaAsset(), permission: () => "allow" })(app);
  return app;
}

async function usage(query: string, scope: ControlPlaneScope = MEDIA_USAGE_READ_SCOPE, app = makeApp()) {
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
    `http://x/media/admin/usage?${query}`,
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    { ...env, ENVIRONMENT },
  );
}

/** Store one finalized upload of `size` bytes for a caller. */
async function stored(userId: string, organizationId: string | null, size: number): Promise<void> {
  const deps = makeDeps(env.DB, caller(userId, organizationId));
  const { id } = await createMedia(deps, {
    type: "audio",
    name: "a",
    filename: "a.mp3",
    contentType: "audio/mpeg",
    size,
  });
  await finalizeMedia(deps, id, {});
}

beforeEach(async () => {
  await resetMediaTables(env.DB);
  // One person in two organizations — the case the non-disclosure rule exists for.
  await stored("shared", "org-a", 100);
  await stored("shared", "org-a", 50);
  await stored("local", "org-a", 30);
  await stored("shared", "org-b", 7000);
});

describe("GET /media/admin/usage", () => {
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
    // `makeApp` composes the media routes with `permission: () => "allow"`; the rollup never asks it.
    const body = UsageResponse.parse(await (await usage("groupBy=owner&organizationId=org-b")).json());
    expect(body.rows).toEqual([{ organizationId: "org-b", ownerId: "shared", records: 1, bytes: 7000 }]);
  });

  test("a connection without the scope is refused", async () => {
    const res = await usage("groupBy=organization", MEDIA_USAGE_READ_SCOPE, makeApp([]));
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
  });
});
