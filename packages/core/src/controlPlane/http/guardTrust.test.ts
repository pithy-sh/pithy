// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import type { AuditEventInput } from "../../audit/auditEvent";
import type { PithyHonoEnv } from "../../capability/capability";
import { pithyErrorHandler } from "../../error/http";
import { memoryJwksCache } from "../../http/oidcWebhook";
import { type MintedKey, mintKey, publishing, signToken } from "../../test-utils/oidcFixtures";
import { ControlPlaneConfig } from "../config/config";
import type { ControlPlaneConnection } from "../data/connection";
import { ANY_VERIFIED_CALLER, KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE } from "../scope/scope";
import {
  CONTROL_PLANE_HEADER,
  CONTROL_PLANE_OIDC_HEADER,
  CONTROL_PLANE_SCOPE_HEADER,
  CONTROL_PLANE_TRUST_HEADER,
} from "../wire";
import { type ControlPlaneVerifier, createControlPlaneVerifier, requireControlPlane } from "./guard";
import { type ControlPlaneHandlerDeps, expireKeyHandler, registerKeyHandler } from "./handlers";

/**
 * The gate over a call made under an OIDC trust (#722): which headers select the trust path, and what the
 * adopter's trail records about it. `verifyTrust.test.ts` owns the decision; this owns the wiring and the rows.
 */

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const AUDIENCE = "https://api.example.com";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const TRUST_ID = "4b8f0c1e-2a7d-4e0b-9c55-0f3a6d2e7b19";
const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const epoch = (at: Date) => Math.floor(at.getTime() / 1000);

let key: MintedKey;
beforeAll(async () => {
  key = await mintKey("gh-1");
});

const connection: ControlPlaneConnection = {
  id: CONNECTION_ID,
  environment: "prod",
  issuer: ISSUER,
  workerUrl: AUDIENCE,
  basePath: "/control-plane",
  managementOrigin: null,
  authorizedBy: "ada@example.com",
  actorKind: "agent",
  purpose: "Nightly audit summarizer.",
  scopes: [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE],
  keys: [],
  trusts: [
    {
      trustId: TRUST_ID,
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      audience: AUDIENCE,
      claims: { repository_id: "1262274726" },
      authorizedBy: "ada@example.com",
      validFrom: new Date("2026-10-01T00:00:00.000Z"),
      revokedAt: null,
      firstCallAt: null,
    },
  ],
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};

function verifier(options: { trusts?: boolean } = {}): ControlPlaneVerifier {
  const keyDeps = {
    loadConnection: async () => null,
    countConnections: async () => 1,
    replay: { claim: async () => true },
    environment: "prod",
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  };
  if (options.trusts === false) return createControlPlaneVerifier(keyDeps);
  return createControlPlaneVerifier(keyDeps, {
    loadEnvironmentConnection: async () => connection,
    environment: "prod",
    now: () => NOW,
    jwksCache: memoryJwksCache({ now: () => NOW }),
    transport: publishing(JWKS_URL, [key.jwk]),
    recordFirstCall: async () => {},
  });
}

function app(events: AuditEventInput[], verify: ControlPlaneVerifier) {
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  hono.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verify);
    c.set("emit", async (event: AuditEventInput) => {
      events.push(event);
    });
    await next();
  });
  hono.get("/control-plane/manifest", requireControlPlane(MANIFEST_READ_SCOPE), (c) =>
    c.json({ controlPlane: c.var.controlPlane }),
  );
  hono.get("/control-plane/ping", requireControlPlane(ANY_VERIFIED_CALLER), (c) => c.json({ ok: true }));
  return hono;
}

async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  return signToken(
    {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "repo:acme/api:ref:refs/heads/main",
      exp: epoch(NOW) + 300,
      iat: epoch(NOW) - 30,
      repository_id: "1262274726",
      ref: "refs/heads/main",
      ...overrides,
    },
    key,
  );
}

async function headers(overrides: Record<string, unknown> = {}, scope = MANIFEST_READ_SCOPE) {
  return {
    [CONTROL_PLANE_OIDC_HEADER]: await token(overrides),
    [CONTROL_PLANE_TRUST_HEADER]: TRUST_ID,
    [CONTROL_PLANE_SCOPE_HEADER]: scope,
  };
}

describe("requireControlPlane under an OIDC trust", () => {
  test("allows a matching token naming a granted scope, and records the trust on the allowed row", async () => {
    const events: AuditEventInput[] = [];
    const response = await app(events, verifier()).request("/control-plane/manifest", { headers: await headers() });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { controlPlane: { credentialKind: string } }).controlPlane.credentialKind).toBe(
      "trust",
    );
    expect(events[0]).toMatchObject({
      action: "controlplane/call_allowed",
      actorType: "control-plane",
      actorId: "repo:acme/api:ref:refs/heads/main",
      resourceId: CONNECTION_ID,
      metadata: { keyId: TRUST_ID, credentialKind: "trust", scope: MANIFEST_READ_SCOPE },
    });
  });

  test("refuses a token for an untrusted subject as an invalid credential, and records what it carried", async () => {
    const events: AuditEventInput[] = [];
    const response = await app(events, verifier()).request("/control-plane/manifest", {
      headers: await headers({ repository_id: "999" }),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("controlplane/invalid_credential");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "controlplane/call_denied",
      outcome: "denied",
      actorId: null,
      metadata: {
        reason: "controlplane/invalid_credential",
        connectionId: CONNECTION_ID,
        trustId: TRUST_ID,
        observedClaims: { sub: "repo:acme/api:ref:refs/heads/main", repository_id: "999", ref: "refs/heads/main" },
      },
    });
  });

  test("refuses a token for an untrusted audience, recording nothing it carried", async () => {
    const events: AuditEventInput[] = [];
    const response = await app(events, verifier()).request("/control-plane/manifest", {
      headers: await headers({ aud: "https://staging.example.com" }),
    });
    expect(response.status).toBe(401);
    expect(events[0]?.metadata).toEqual({
      reason: "controlplane/invalid_credential",
      required: MANIFEST_READ_SCOPE,
      method: "GET",
      path: "/control-plane/manifest",
    });
  });

  test("refuses a token naming an ungranted scope like a key's, naming the trust", async () => {
    const events: AuditEventInput[] = [];
    const response = await app(events, verifier()).request("/control-plane/manifest", {
      headers: { ...(await headers()), [CONTROL_PLANE_SCOPE_HEADER]: "audit:events:read" },
    });
    expect(response.status).toBe(403);
    expect(events[0]).toMatchObject({
      action: "controlplane/call_denied",
      actorId: "repo:acme/api:ref:refs/heads/main",
      resourceId: CONNECTION_ID,
      metadata: { reason: "controlplane/insufficient_scope", keyId: TRUST_ID },
    });
  });

  test("refuses a call presenting both a signed token and an OIDC token", async () => {
    const events: AuditEventInput[] = [];
    const response = await app(events, verifier()).request("/control-plane/ping", {
      headers: { ...(await headers()), [CONTROL_PLANE_HEADER]: "a.b.c" },
    });
    expect(response.status).toBe(401);
  });

  test("fails closed when the Worker verifies no trusts", async () => {
    const events: AuditEventInput[] = [];
    const response = await app(events, verifier({ trusts: false })).request("/control-plane/ping", {
      headers: await headers(),
    });
    expect(response.status).toBe(401);
    expect(events[0]?.action).toBe("controlplane/call_denied");
  });
});

describe("a call under an OIDC trust cannot change the connection's keys", () => {
  /** Never reached: the refusal comes before the handler opens its database. */
  const deps = {
    database: () => {
      throw new Error("the handler reached its database");
    },
    now: () => NOW,
  } as unknown as ControlPlaneHandlerDeps;

  function keyApp(events: AuditEventInput[]) {
    const hono = app(events, verifier());
    hono.post("/control-plane/keys", requireControlPlane(KEYS_ROTATE_SCOPE), (c) =>
      registerKeyHandler(deps)(c, {
        keyId: "minted-by-a-workload",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
      }),
    );
    hono.post("/control-plane/keys/old/expire", requireControlPlane(KEYS_ROTATE_SCOPE), (c) =>
      expireKeyHandler(deps)(c, { keyId: "old" }, { provenKeyId: TRUST_ID }),
    );
    return hono;
  }

  test("registering a key is refused, even with keys:rotate granted — that would be an exchange", async () => {
    const response = await keyApp([]).request("/control-plane/keys", {
      method: "POST",
      headers: await headers({}, KEYS_ROTATE_SCOPE),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("controlplane/key_conflict");
  });

  test("expiring a key is refused too", async () => {
    const response = await keyApp([]).request("/control-plane/keys/old/expire", {
      method: "POST",
      headers: await headers({}, KEYS_ROTATE_SCOPE),
    });
    expect(response.status).toBe(409);
  });
});
