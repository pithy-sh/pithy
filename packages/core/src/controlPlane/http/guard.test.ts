// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import type { PithyHonoEnv } from "../../capability/capability";
import { pithyErrorHandler } from "../../error/http";
import { validationHook } from "../../http/validation";
import { ControlPlaneConfig } from "../config/config";
import type { ControlPlaneConnection, Ed25519PublicJwk } from "../data/connection";
import type { ReplayGuard } from "../replay/guard";
import { KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER, CONTROL_PLANE_VERSION_CREATED_HEADER, CONTROL_PLANE_VERSION_HEADER } from "../wire";
import {
  type ControlPlaneVerifier,
  createControlPlaneVerifier,
  requireControlPlane,
  workerVersionHeaders,
} from "./guard";
import { RegisterKeyRequest } from "./schemas";

/**
 * The gate and the verifier it consumes, against a real Hono app.
 *
 * `verify.test.ts` owns the decision; this file owns the wiring around it — where the token is read
 * from, what lands on the request, and what a route sees afterwards. Two of those are security
 * properties rather than plumbing: the gate must **deny when the seam is not composed**, and reading
 * the body to check its digest must not consume it out from under the route's validator.
 */

const NOW = new Date("2026-03-01T00:00:00.000Z");
const CONNECTION_ID = "0d1f4b6e-7c2a-4f52-9c1f-2b6a5d3e8a91";
const ISSUER = "https://app.pithy.sh";
const ENVIRONMENT = "production";
const KEY_ID = "key_2026_03";
const SUBJECT = "usr_7f3c";

let keyPair: CryptoKeyPair;
let publicJwk: Ed25519PublicJwk;
let connection: ControlPlaneConnection;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicJwk = await exportPublicJwk(keyPair.publicKey);
  connection = {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    scopes: [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE],
    keys: [
      {
        keyId: KEY_ID,
        publicKey: publicJwk,
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
});

/** A replay guard that lets every distinct jti through once — the real one's behaviour, without KV. */
function replayGuard(): ReplayGuard {
  const seen = new Set<string>();
  return {
    async claim(jti) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}

/** The verifier the seam's middleware publishes, over the one registered connection. */
function verifier(): ControlPlaneVerifier {
  return createControlPlaneVerifier({
    loadConnection: async (id) => (id === connection.id ? connection : null),
    countConnections: async () => 1,
    replay: replayGuard(),
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

function token(options: { scope: string; body?: Uint8Array }): Promise<string> {
  return mintControlPlaneToken({
    privateKey: keyPair.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: SUBJECT,
    scope: options.scope,
    body: options.body,
    now: () => NOW,
  });
}

/**
 * Two routes, wired the way `registerControlPlaneRoutes` wires them: guard first, validator second.
 * The seams are seeded the way `createBackend` seeds them — `auth` explicitly null, so the assertion
 * that a control-plane call never sets it is testing the gate rather than an absent variable.
 */
function makeApp(options: { verifier?: ControlPlaneVerifier | null } = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", options.verifier ?? null);
    await next();
  });

  app.get("/control-plane/manifest", requireControlPlane(MANIFEST_READ_SCOPE), (c) =>
    c.json({ controlPlane: c.var.controlPlane, auth: c.var.auth }),
  );

  app.post(
    "/control-plane/keys",
    requireControlPlane(KEYS_ROTATE_SCOPE),
    zValidator("json", RegisterKeyRequest, validationHook),
    (c) => c.json({ received: c.req.valid("json") }),
  );

  return app;
}

describe("requireControlPlane", () => {
  test("denies every gated route when the seam is not composed", async () => {
    // **The fail-closed property.** A capability contributing admin routes — `@pithy-sh/payments` is
    // the first — writes `requireControlPlane(...)` at module scope and cannot know whether the adopter
    // enabled the seam. With no verifier on the request there is nothing to authorize against, so the
    // route must DENY rather than stand open because the thing meant to protect it is absent. A package
    // that imports its authorization from elsewhere has to deny when that elsewhere is missing.
    const response = await makeApp({ verifier: null }).request("/control-plane/manifest");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "controlplane/not_connected" } });
  });

  test("tells an operator how to connect, and tells the wire nothing else", async () => {
    // The one denial that is safe to explain: nothing is registered, so there is nothing to enumerate.
    // The throw-site context still stays internal — the codec strips `detail` here as everywhere.
    const response = await makeApp({ verifier: null }).request("/control-plane/manifest");
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(body.error.action).toContain("pithy dashboard connect");
    expect(body.error).not.toHaveProperty("detail");
  });

  test("a verified call sets c.var.controlPlane and leaves c.var.auth null", async () => {
    // The seams must never be conflated. A management client holds no session and owns no user row, so
    // if a control-plane call populated `auth`, every `requireAuth()` in every capability would pass
    // for it — a scope escalation across the whole tree from one convenient assignment.
    const response = await makeApp({ verifier: verifier() }).request("/control-plane/manifest", {
      headers: { [CONTROL_PLANE_HEADER]: await token({ scope: MANIFEST_READ_SCOPE }) },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      auth: null,
      controlPlane: {
        connectionId: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        subject: SUBJECT,
        scope: MANIFEST_READ_SCOPE,
        grantedScopes: [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE],
        keyId: KEY_ID,
        tokenId: expect.any(String),
      },
    });
  });

  test("runs before the validator, so a credential-less call is a 401 and not a 400", async () => {
    // Guards precede validators on every route line. Reversed, an unauthenticated caller would learn
    // which request shapes are well-formed — on key registration that is a live oracle.
    const response = await makeApp({ verifier: verifier() }).request("/control-plane/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "controlplane/invalid_credential" } });
  });
});

/**
 * Every `env` worth asking the question of: the shape a real `wrangler dev` hands a Worker, the tagged
 * and untagged deploys, a binding mid-platform-change, and the hostile ones that reach `unknown`.
 */
const ENVS: unknown[] = [
  {
    CF_VERSION_METADATA: { id: "6bbf9e9b-90c6-46c5-829d-83241554ac2c", tag: "", timestamp: "2026-08-10T21:39:55.716Z" },
  },
  { CF_VERSION_METADATA: { id: "v-abc", tag: "release-42", timestamp: "2026-08-10T21:39:55.716Z" } },
  { CF_VERSION_METADATA: { id: "v-abc" } },
  { CF_VERSION_METADATA: { timestamp: "2026-08-10T21:39:55.716Z" } },
  { CF_VERSION_METADATA: { id: "v-abc", timestamp: "yesterday" } },
  { CF_VERSION_METADATA: { id: "v-abc", timestamp: 1_754_863_195_716 } },
  { CF_VERSION_METADATA: { id: "", tag: "", timestamp: "" } },
  { CF_VERSION_METADATA: {} },
  { CF_VERSION_METADATA: null },
  {},
  null,
  undefined,
  "env",
  7,
  [],
];

/** Every string the binding itself carried — the only values the seam is allowed to put on the wire. */
function handedTo(env: unknown): Set<string> {
  const values = new Set<string>();
  if (typeof env !== "object" || env === null || Array.isArray(env)) return values;
  const meta = (env as Record<string, unknown>).CF_VERSION_METADATA;
  if (typeof meta !== "object" || meta === null) return values;
  for (const value of Object.values(meta as Record<string, unknown>)) {
    if (typeof value === "string") values.add(value);
  }
  return values;
}

describe("workerVersionHeaders", () => {
  test("stamps only what the binding handed it, verbatim, and stamps nothing else", () => {
    // **The invariant, not a field list.** Everything this seam says about the running build is a value
    // the platform handed this Worker, byte for byte — never defaulted, never computed at request time,
    // never re-encoded. It crosses to a management client the customer scoped, so a value the Worker
    // invented would be indistinguishable from one it was told, and a client invalidating a rendered
    // pane on it would act on a fact nobody stated.
    for (const env of ENVS) {
      const headers = workerVersionHeaders(env);
      const handed = handedTo(env);
      for (const [name, value] of Object.entries(headers)) {
        expect([CONTROL_PLANE_VERSION_HEADER, CONTROL_PLANE_VERSION_CREATED_HEADER]).toContain(name);
        expect({ env, name, value, handed: [...handed] }).toMatchObject({ handed: expect.arrayContaining([value]) });
      }
      // And anything stamped as a time is a time. A client subtracts these; `NaN` compares false against
      // everything, so an unparseable string would read as "not newer" — silently "unchanged".
      const created = headers[CONTROL_PLANE_VERSION_CREATED_HEADER];
      if (created !== undefined) expect(Number.isFinite(Date.parse(created))).toBe(true);
    }
  });

  test("says nothing at all where the binding says nothing", () => {
    // **Absence is never change.** An unbound Worker, a binding gone, a field that carried nothing
    // usable — each is "this Worker cannot say", and each must reach the client as silence. An empty
    // header value is a value: a client comparing it against what it last saw reads a deploy.
    for (const env of [{}, null, undefined, "env", 7, [], { CF_VERSION_METADATA: null }, { CF_VERSION_METADATA: {} }]) {
      expect(workerVersionHeaders(env)).toEqual({});
    }
    expect(workerVersionHeaders({ CF_VERSION_METADATA: { id: "", tag: "", timestamp: "" } })).toEqual({});
  });

  test("carries both halves when the platform has both, so the invariant above is not vacuous", () => {
    // Stamping nothing would satisfy every assertion up there. This is what the issue asked for: the
    // build, and when that build was made, as two values a client compares separately.
    expect(
      workerVersionHeaders({
        CF_VERSION_METADATA: { id: "v-deadbeef", tag: "release-42", timestamp: "2026-08-10T21:39:55.716Z" },
      }),
    ).toEqual({
      [CONTROL_PLANE_VERSION_HEADER]: "v-deadbeef",
      [CONTROL_PLANE_VERSION_CREATED_HEADER]: "2026-08-10T21:39:55.716Z",
    });
  });

  test("keeps the tag off the wire", () => {
    // Read by the identity reader, deliberately not stamped. It is adopter-authored free text on a
    // header crossing to a management client, and neither question a client asks — "different build?",
    // "same build, deployed again?" — is answered by it. More than identity wants a reason.
    const headers = workerVersionHeaders({
      CF_VERSION_METADATA: { id: "v-abc", tag: "internal-hotfix-CVE-2026-1", timestamp: "2026-08-10T21:39:55.716Z" },
    });
    expect(JSON.stringify(headers)).not.toContain("internal-hotfix");
  });
});

describe("createControlPlaneVerifier", () => {
  test("reads the token from the pithy-control-plane header", async () => {
    const response = await makeApp({ verifier: verifier() }).request("/control-plane/manifest", {
      headers: { [CONTROL_PLANE_HEADER]: await token({ scope: MANIFEST_READ_SCOPE }) },
    });

    expect(response.status).toBe(200);
  });

  test("ignores a control-plane token presented on Authorization", async () => {
    // The header is not `Authorization` on purpose: `@pithy-sh/auth` builds a Better Auth instance for
    // any request carrying one, so a management call would drag the session stack in behind it. The
    // seam reads its own header and nothing else, which is what keeps the two strategies separate.
    const response = await makeApp({ verifier: verifier() }).request("/control-plane/manifest", {
      headers: { authorization: `Bearer ${await token({ scope: MANIFEST_READ_SCOPE })}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "controlplane/invalid_credential" } });
  });

  test("clones the body, so a verified POST still reaches its validator intact", async () => {
    // The digest check has to read the request body. Reading the original stream would leave the
    // route's `zValidator("json", …)` an empty body: verification would pass and the call would then
    // fail validation for no visible reason — a bug that only appears on write routes, which are
    // exactly the ones worth protecting. So the verifier clones, and this asserts it.
    const registration = { keyId: "key_2026_04", publicKey: publicJwk };
    // One serialization, used for both the digest and the wire. Two would risk differing bytes and
    // would be testing JSON.stringify rather than the clone.
    const body = JSON.stringify(registration);

    const response = await makeApp({ verifier: verifier() }).request("/control-plane/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CONTROL_PLANE_HEADER]: await token({ scope: KEYS_ROTATE_SCOPE, body: new TextEncoder().encode(body) }),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: registration });
  });
});
