// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { beforeEach, describe, expect, test } from "vitest";
import { media } from "../capability";
import { MEDIA_R2_SECRET, mediaOwnSecretsRegistry } from "../secret/registry";
import { resetMediaTables } from "../test-utils/harness";
import { MediaDeliveryResponse } from "./responses";
import { MEDIA_DELIVERY_READ_SCOPE, MEDIA_USAGE_READ_SCOPE } from "./scopes";

/**
 * **An R2-only media project serves every media route (#728).** The regression this pins: `media()` for a
 * project storing both types in R2 declares no runtime token, and the routes' default resolvers read their
 * secrets through a registry that named one — so the shared reader refused a name the Worker never
 * declared, and every route answered 500. Here the capability is composed whole, through `createBackend`
 * beside `secrets()`, and nothing on the request path is stubbed but the caller's identity.
 */

const SHA = "a".repeat(64);

/** Who is calling: a user from `x-user`, or a management client granted `x-scopes`. */
const identity = defineCapability({
  name: "identity",
  requiredBindings: [],
  middleware: [
    (app) =>
      app.use("*", async (c, next) => {
        const user = c.req.header("x-user");
        c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
        const granted = (c.req.header("x-scopes") ?? "").split(",").filter(Boolean);
        const verify: ControlPlaneVerifier = async (_request, requirement) => {
          if (typeof requirement === "string" && !granted.includes(requirement)) throw new Error("ungranted");
          return {
            connectionId: "conn-1",
            environment: "dev",
            issuer: "https://dashboard.example",
            subject: "operator-1",
            scope: String(requirement),
            grantedScopes: granted,
            keyId: "key-1",
            tokenId: "jti-1",
            actorKind: "dashboard",
          } satisfies ControlPlaneContext;
        };
        c.set("controlPlaneVerifier", granted.length > 0 ? verify : null);
        await next();
      }),
  ],
});

function backend() {
  return createBackend({
    capabilities: [
      secrets({ registry: {} }),
      media({ images: { store: "r2" }, video: { store: "r2" }, visibility: { default: "private" } }),
      identity,
    ],
  });
}

/** One request through the composed Worker, as the signed-in owner unless told otherwise. */
async function call(path: string, init: RequestInit & { as?: Record<string, string> } = {}) {
  const { as = { "x-user": "owner" }, ...rest } = init;
  const headers = { "content-type": "application/json", ...as, ...(rest.headers as Record<string, string>) };
  return backend().request(path, { ...rest, headers }, env);
}

beforeEach(async () => {
  await resetMediaTables(env.DB);
  await seedSecrets(env, mediaOwnSecretsRegistry, {
    [MEDIA_R2_SECRET]: {
      accessKeyId: "AKIA-test",
      secretAccessKey: "secret-test",
      accountId: "acct-1",
      bucket: "acme-dev-media",
    },
  });
});

describe("an R2-only media project, composed whole (#728)", () => {
  test("declares no runtime token, so nothing on its request path may read one", () => {
    const cap = media({ images: { store: "r2" }, video: { store: "r2" } });
    expect(cap.runtimePermissions).toEqual([]);
    expect(Object.keys(cap.secretRegistry ?? {}).sort()).toEqual(Object.keys(mediaOwnSecretsRegistry).sort());
  });

  test("serves every app route: upload, finalize, read, deliver, rename, list, find duplicates, delete", async () => {
    const ids: Record<string, string> = {};
    for (const type of ["image", "video", "audio", "document"] as const) {
      const created = await call("/media", {
        method: "POST",
        body: JSON.stringify({
          type,
          name: `a ${type}`,
          filename: `a.${type}`,
          contentType: "application/octet-stream",
          size: 3,
        }),
      });
      expect(created.status, `upload-init ${type}: ${await created.clone().text()}`).toBe(201);
      const body = (await created.json()) as { id: string; uploadUrl: string };
      expect(body.uploadUrl).toContain("X-Amz-Signature=");
      ids[type] = body.id;
    }
    const image = ids.image as string;

    const finalized = await call(`/media/${image}/finalize`, {
      method: "POST",
      body: JSON.stringify({ size: 3, sha256: SHA }),
    });
    expect(finalized.status).toBe(200);
    expect(((await finalized.json()) as { status: string }).status).toBe("stored");

    expect((await call(`/media/${image}`)).status).toBe(200);

    const url = await call(`/media/${image}/url`);
    expect(url.status).toBe(200);
    expect(((await url.json()) as { url: string }).url).toContain("X-Amz-Signature=");

    const renamed = await call(`/media/${image}`, { method: "PATCH", body: JSON.stringify({ name: "renamed" }) });
    expect(renamed.status).toBe(200);

    const listed = await call("/media");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(4);

    const duplicates = await call("/media/duplicates", {
      method: "POST",
      body: JSON.stringify({ type: "image", sha256: SHA }),
    });
    expect(duplicates.status).toBe(200);

    const deleted = await call(`/media/${image}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await call(`/media/${image}`)).status).toBe(404);
  });

  test("serves the usage read to a management client holding its scope", async () => {
    const usage = await call("/media/admin/usage?groupBy=organization", { as: { "x-scopes": MEDIA_USAGE_READ_SCOPE } });
    expect(usage.status, await usage.clone().text()).toBe(200);
  });

  test("serves the delivery read, naming both types as unreported and why — never as zero", async () => {
    const response = await call("/media/admin/delivery", { as: { "x-scopes": MEDIA_DELIVERY_READ_SCOPE } });
    expect(response.status).toBe(200);
    const body = MediaDeliveryResponse.parse(await response.json());
    expect(body.video).toMatchObject({ state: "unavailable", reason: "stored-in-r2" });
    expect(body.images).toMatchObject({ state: "unavailable", reason: "stored-in-r2" });
  });
});
