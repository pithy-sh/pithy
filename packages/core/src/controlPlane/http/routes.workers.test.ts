// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { controlplane } from "../capability";
import { ControlPlaneConnection, type Ed25519PublicJwk, type RegisteredKey } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { ControlPlaneManifest } from "../discovery/adminRoute";
import { controlplane_0001_connections } from "../migrations/0001_connections";
import { KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER } from "./verify";

/**
 * The seam end to end, in workerd: a real composed backend, real D1, real KV, real Ed25519 tokens.
 *
 * Nothing here is a fixture. Every token is minted with `mintControlPlaneToken` and verified by the
 * same pipeline a deployed Worker runs, against a connection row that went through
 * `ControlPlaneConnection.encode` into the table `controlplane_0001_connections` created. So a test
 * that passes here is a statement about the shipped seam, not about a mock of it.
 *
 * Two properties are load-bearing and are asserted first, because they are what an adopter is trusting:
 * a Worker nobody has connected denies everything, and a rotation that goes wrong leaves the old key
 * working.
 *
 * `ENVIRONMENT` is supplied on the bindings. It is the value a credential is bound to; absent, the seam
 * compares against the empty string, matches no connection, and denies — correct, but it would make
 * every case below pass for the wrong reason.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://app.pithy.sh";
const CONNECTION_ID = "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b";
const SUBJECT = "usr_dashboard_operator";

/** The Worker's env for every request: the real Miniflare bindings plus the environment name. */
const BINDINGS = { ...env, ENVIRONMENT };

/**
 * A capability with no management surface — the ordinary case, and the one the manifest must still
 * report so "composed but nothing to administer" is distinguishable from "not installed".
 */
const quiet = defineCapability({ name: "quiet", requiredBindings: [] });

/** One composed backend, exactly as a Worker assembles it. Stateless — every request re-reads D1. */
const backend = createBackend({ capabilities: [controlplane(), quiet] });

/** A management client's key pair: the private half it signs with, the public half the adopter stores. */
interface Signer {
  keyId: string;
  privateKey: CryptoKey;
  publicKey: Ed25519PublicJwk;
}

async function signer(keyId: string): Promise<Signer> {
  // `generateKey`'s type is the union over every algorithm; Ed25519 always yields a pair.
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { keyId, privateKey: pair.privateKey, publicKey: await exportPublicJwk(pair.publicKey) };
}

/** The registration record for a signer. Open-ended and already started, unless a case says otherwise. */
function registered(key: Signer, overrides: Partial<RegisteredKey> = {}): RegisteredKey {
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    validFrom: new Date(Date.now() - 60_000),
    validUntil: null,
    revokedAt: null,
    ...overrides,
  };
}

/** Register a connection — what `pithy dashboard connect` writes, and the only thing that opens the seam. */
async function connect(keys: RegisteredKey[], scopes: string[] = [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE]) {
  const now = new Date();
  const connection: ControlPlaneConnection = {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://api.acme.example",
    scopes,
    keys,
    createdAt: now,
    updatedAt: now,
  };
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(ControlPlaneConnection.encode(connection))
    .execute();
  return connection;
}

/** The persisted row, decoded — for the assertions that must see D1 and not a handler's return value. */
async function persisted(): Promise<ControlPlaneConnection> {
  const row = await controlPlaneDatabase(env.DB)
    .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
    .selectAll()
    .where("id", "=", CONNECTION_ID)
    .executeTakeFirstOrThrow();
  return ControlPlaneConnection.parse(row);
}

interface Call {
  /** The key to sign with. Omit to send no credential at all. */
  key?: Signer;
  /** The single scope the token is minted for. */
  scope?: string;
  /** The JSON body, serialized once and bound into the token's digest. */
  body?: unknown;
  /** A pre-minted token, verbatim — the replay case presents the same one twice. */
  token?: string;
  /** The connection the token addresses. Defaults to the registered one. */
  connectionId?: string;
}

/** Mint the token a call would carry, so a case can present the same one twice. */
async function mint(key: Signer, options: { scope: string; body?: unknown; connectionId?: string }): Promise<string> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return mintControlPlaneToken({
    privateKey: key.privateKey,
    keyId: key.keyId,
    issuer: ISSUER,
    connectionId: options.connectionId ?? CONNECTION_ID,
    subject: SUBJECT,
    scope: options.scope,
    body: payload === undefined ? undefined : new TextEncoder().encode(payload),
  });
}

/** Drive one real HTTP request at the composed backend. */
async function call(method: string, path: string, options: Call = {}): Promise<Response> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const token =
    options.token ??
    (options.key
      ? await mint(options.key, {
          scope: options.scope ?? MANIFEST_READ_SCOPE,
          body: options.body,
          connectionId: options.connectionId,
        })
      : undefined);

  const headers: Record<string, string> = {};
  if (token) headers[CONTROL_PLANE_HEADER] = token;
  if (payload !== undefined) headers["content-type"] = "application/json";
  return backend.request(`http://worker.example${path}`, { method, headers, body: payload }, BINDINGS);
}

/** The public wire shape of one registered key — windows and public material, nothing else. */
interface PublicKeyView {
  keyId: string;
  publicKey: Ed25519PublicJwk;
  validFrom: string;
  validUntil: string | null;
  revokedAt: string | null;
}

interface WireError {
  error: { code: string; status: number; message: string; action?: string; detail?: string };
}

async function body<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

/** A denial, kept as raw text too — `detail` must be absent from the bytes, not merely from the parse. */
async function denial(response: Response): Promise<{ text: string; error: WireError["error"] }> {
  const text = await response.text();
  return { text, error: (JSON.parse(text) as WireError).error };
}

/** Every route the seam serves, with a body where one is required — the "deny everything" sweep. */
function everyRoute(): { method: string; path: string; scope: string; body?: unknown }[] {
  return [
    { method: "GET", path: "/control-plane/ping", scope: MANIFEST_READ_SCOPE },
    { method: "GET", path: "/control-plane/manifest", scope: MANIFEST_READ_SCOPE },
    { method: "GET", path: "/control-plane/keys", scope: KEYS_ROTATE_SCOPE },
    {
      method: "POST",
      path: "/control-plane/keys",
      scope: KEYS_ROTATE_SCOPE,
      body: {
        keyId: "cpk_new",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
      },
    },
    {
      method: "POST",
      path: "/control-plane/keys/cpk_old/expire",
      scope: KEYS_ROTATE_SCOPE,
      body: { provenKeyId: "cpk_new" },
    },
  ];
}

let alice: Signer;
let bob: Signer;
let carol: Signer;

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await controlplane_0001_connections.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  [alice, bob, carol] = await Promise.all([signer("cpk_alice"), signer("cpk_bob"), signer("cpk_carol")]);
});

describe("a Worker nobody has connected", () => {
  test("denies every one of the five routes with controlplane/not_connected", async () => {
    // The shipped state. The seam is composed, the table exists, and there is no flag that opens it —
    // `pithy dashboard connect` is the deliberate second step, and until then a perfectly well-formed,
    // correctly signed credential gets 403 on every route.
    for (const route of everyRoute()) {
      const response = await call(route.method, route.path, { key: alice, scope: route.scope, body: route.body });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect((await denial(response)).error.code, `${route.method} ${route.path}`).toBe("controlplane/not_connected");
    }
  });
});

describe("GET /control-plane/ping", () => {
  test("answers a verified caller and names the key that verified it", async () => {
    await connect([registered(alice)]);

    const response = await call("GET", "/control-plane/ping", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(response.status).toBe(200);
    const json = await body<{ status: string; connectionId: string; environment: string; keyId: string }>(response);
    // Echoing the key is what lets a client confirm *which* key answered before expiring the other one.
    expect(json).toMatchObject({
      status: "ok",
      connectionId: CONNECTION_ID,
      environment: ENVIRONMENT,
      keyId: "cpk_alice",
    });
  });

  test("needs no granted scope, so a connection granted nothing can still prove a key", async () => {
    // Ping is not grantable. A connection that could not ping could reach a state where a replacement
    // key can never be proven — and then the old key is either never retired or retired blindly.
    await connect([registered(alice)], []);
    expect((await call("GET", "/control-plane/ping", { key: alice, scope: "anything:atall" })).status).toBe(200);
  });
});

describe("GET /control-plane/manifest", () => {
  test("reports what this Worker composed, which is how a client discovers its surface", async () => {
    await connect([registered(alice)]);

    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(response.status).toBe(200);
    const json = await body<ControlPlaneManifest>(response);
    expect(json.capabilities.map((capability) => capability.name)).toContain("controlplane");
    expect(json.grantedScopes).toEqual([MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE]);
    expect(json.connectionId).toBe(CONNECTION_ID);
    // The response is the contract a management client parses, so it parses here too. A field renamed
    // without the schema noticing would break every client and nothing else.
    expect(() => ControlPlaneManifest.parse(json)).not.toThrow();
  });

  test("describes how to call each route, not merely that a capability exists", async () => {
    // The whole point of the manifest. Knowing `controlplane` is composed does not tell a client where
    // it is mounted or which scope each route needs — and `basePath` is configurable, so assuming is
    // how a client 404s against every adopter who customised anything.
    await connect([registered(alice)]);

    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    const json = await body<ControlPlaneManifest>(response);
    const seam = json.capabilities.find((capability) => capability.name === "controlplane");

    expect(seam?.adminRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /control-plane/keys",
      "GET /control-plane/manifest",
      "GET /control-plane/ping",
      "POST /control-plane/keys",
      "POST /control-plane/keys/:keyId/expire",
    ]);
    // Every route says what it needs, so a client can grey out what this connection cannot do rather
    // than discovering a 403 by pressing the button.
    expect(seam?.adminRoutes.find((route) => route.path.endsWith("/ping"))?.scope).toBeNull();
    expect(seam?.adminRoutes.find((route) => route.method === "POST" && route.path.endsWith("/keys"))?.scope).toBe(
      KEYS_ROTATE_SCOPE,
    );
    for (const route of seam?.adminRoutes ?? []) expect(route.summary.length).toBeGreaterThan(0);
  });

  test("a capability with no management surface is reported, with an empty route list", async () => {
    // "Composed but has nothing to administer" and "not installed" are different facts, and a client
    // that cannot tell them apart renders the wrong thing for both.
    await connect([registered(alice)]);

    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    const json = await body<ControlPlaneManifest>(response);
    const plain = json.capabilities.find((capability) => capability.name === "quiet");

    expect(plain).toBeDefined();
    expect(plain?.adminRoutes).toEqual([]);
  });

  test("requires manifest:read — a connection never granted it is refused", async () => {
    await connect([registered(alice)], [KEYS_ROTATE_SCOPE]);

    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(response.status).toBe(403);
    expect((await denial(response)).error.code).toBe("controlplane/insufficient_scope");
  });
});

describe("GET /control-plane/keys", () => {
  test("returns the public keys and their windows, and nothing private", async () => {
    await connect([registered(alice), registered(bob, { revokedAt: new Date() })]);

    const response = await call("GET", "/control-plane/keys", { key: alice, scope: KEYS_ROTATE_SCOPE });
    expect(response.status).toBe(200);
    const text = await response.text();
    const json = JSON.parse(text) as { connectionId: string; keys: PublicKeyView[] };

    expect(json.connectionId).toBe(CONNECTION_ID);
    expect(json.keys.map((key) => key.keyId)).toEqual(["cpk_alice", "cpk_bob"]);
    expect(json.keys[0]?.publicKey).toEqual(alice.publicKey);
    expect(json.keys[0]?.validUntil).toBeNull();
    expect(json.keys[1]?.revokedAt).toEqual(expect.any(String));

    // A JWK carries the private scalar in `d`. The adopter never holds one, so it can never leak — this
    // asserts the shape stays that way, over the bytes rather than over a parsed object.
    for (const key of json.keys) expect(Object.keys(key.publicKey).sort()).toEqual(["crv", "kty", "x"]);
    expect(text).not.toMatch(/"d"\s*:/);
  });
});

describe("key rotation", () => {
  test("append, prove both, then expire — and the retired key stops working", async () => {
    await connect([registered(alice)]);

    // 1. Append. Signed by the key being replaced: trust flows forward from existing trust.
    const registration = await call("POST", "/control-plane/keys", {
      key: alice,
      scope: KEYS_ROTATE_SCOPE,
      body: { keyId: bob.keyId, publicKey: bob.publicKey },
    });
    expect(registration.status).toBe(201);
    expect((await body<{ keys: PublicKeyView[] }>(registration)).keys.map((k) => k.keyId)).toEqual([
      "cpk_alice",
      "cpk_bob",
    ]);

    // 2. The overlap. Both keys verify, and that is the whole safety property — the old one is still
    //    live while the new one is being proven.
    expect((await call("GET", "/control-plane/ping", { key: alice, scope: MANIFEST_READ_SCOPE })).status).toBe(200);
    const proof = await call("GET", "/control-plane/ping", { key: bob, scope: MANIFEST_READ_SCOPE });
    expect(proof.status).toBe(200);
    expect((await body<{ keyId: string }>(proof)).keyId).toBe("cpk_bob");

    // 3. Expire, naming the proven successor. A separate call, deliberately.
    const expiry = await call("POST", "/control-plane/keys/cpk_alice/expire", {
      key: bob,
      scope: KEYS_ROTATE_SCOPE,
      body: { provenKeyId: bob.keyId },
    });
    expect(expiry.status).toBe(200);
    expect(
      (await body<{ keys: PublicKeyView[] }>(expiry)).keys.find((k) => k.keyId === "cpk_alice")?.validUntil,
    ).toEqual(expect.any(String));

    // 4. Afterwards the old key is refused and the new one still works.
    const retired = await call("GET", "/control-plane/ping", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(retired.status).toBe(401);
    expect((await denial(retired)).error.code).toBe("controlplane/invalid_credential");
    expect((await call("GET", "/control-plane/ping", { key: bob, scope: MANIFEST_READ_SCOPE })).status).toBe(200);
  });

  test("a rotation that is never finished leaves the old key working", async () => {
    // The failure this design exists for: the client registers a replacement and then something goes
    // wrong — it cannot sign with the new private key, or it simply stops. Nothing was taken away.
    await connect([registered(alice)]);
    expect(
      (
        await call("POST", "/control-plane/keys", {
          key: alice,
          scope: KEYS_ROTATE_SCOPE,
          body: { keyId: bob.keyId, publicKey: bob.publicKey },
        })
      ).status,
    ).toBe(201);

    // Read the persisted row, not the handler's answer: registration must have appended without moving
    // any existing key's window, and that is a fact about D1.
    const row = await persisted();
    expect(row.keys.map((key) => key.keyId)).toEqual(["cpk_alice", "cpk_bob"]);
    expect(row.keys.every((key) => key.validUntil === null && key.revokedAt === null)).toBe(true);

    expect((await call("GET", "/control-plane/ping", { key: alice, scope: MANIFEST_READ_SCOPE })).status).toBe(200);
    expect((await call("GET", "/control-plane/ping", { key: bob, scope: MANIFEST_READ_SCOPE })).status).toBe(200);
  });

  test("expiring the only key is refused, and the key still works afterwards", async () => {
    // The lockout, refused at the last possible moment. `provenKeyId` is live and the caller is fully
    // authorized — the operation is simply not one the seam will perform.
    await connect([registered(alice)]);

    const response = await call("POST", "/control-plane/keys/cpk_alice/expire", {
      key: alice,
      scope: KEYS_ROTATE_SCOPE,
      body: { provenKeyId: alice.keyId },
    });
    expect(response.status).toBe(409);
    expect((await denial(response)).error.code).toBe("controlplane/key_conflict");

    expect((await persisted()).keys[0]?.validUntil).toBeNull();
    expect((await call("GET", "/control-plane/ping", { key: alice, scope: MANIFEST_READ_SCOPE })).status).toBe(200);
  });

  test("a provenKeyId that is not live is refused, registered or not", async () => {
    // Proof is by use. A key the caller merely names — unregistered, or registered and revoked — has
    // proven nothing, and expiring on that basis is how a rotation locks an adopter out.
    await connect([registered(alice), registered(bob), registered(carol, { revokedAt: new Date() })]);

    const unknown = await call("POST", "/control-plane/keys/cpk_alice/expire", {
      key: alice,
      scope: KEYS_ROTATE_SCOPE,
      body: { provenKeyId: "cpk_never_registered" },
    });
    expect(unknown.status).toBe(409);
    expect((await denial(unknown)).error.code).toBe("controlplane/key_conflict");

    const revoked = await call("POST", "/control-plane/keys/cpk_alice/expire", {
      key: alice,
      scope: KEYS_ROTATE_SCOPE,
      body: { provenKeyId: carol.keyId },
    });
    expect(revoked.status).toBe(409);
    expect((await denial(revoked)).error.code).toBe("controlplane/key_conflict");

    expect((await persisted()).keys[0]?.validUntil).toBeNull();
  });

  test("expiry refuses a successor that did not sign the request — proof is by use, not by assertion", async () => {
    // The lockout this closes: a client still signing with the OLD key names a successor it has never
    // actually used, and retires the one key that currently works. Naming a live key is not proof that
    // the client can sign with it — only signing with it is. So the key that verified this request must
    // be the key being named.
    await connect([registered(alice), registered(bob)]);

    const response = await call("POST", `/control-plane/keys/${alice.keyId}/expire`, {
      key: alice,
      scope: KEYS_ROTATE_SCOPE,
      body: { provenKeyId: bob.keyId },
    });

    expect(response.status).toBe(409);
    expect((await denial(response)).error.code).toBe("controlplane/key_conflict");
    // And nothing moved: the key the client tried to retire is still open-ended.
    expect((await persisted()).keys.find((k) => k.keyId === alice.keyId)?.validUntil).toBeNull();
  });

  test("an unknown but well-formed key id reaches the handler and answers 404, never 400", async () => {
    // The route must not become an enumeration oracle. A validator that rejected unfamiliar shapes would
    // tell a caller which ids exist by the status code alone, so `keyId` is a bounded string and the
    // lookup — not the schema — decides.
    await connect([registered(alice), registered(bob)]);

    // Signed with `bob` and naming `bob` as the proven successor, so the proof-by-use check passes and
    // the target lookup is what decides. Naming a key other than the one that signed is its own 409,
    // covered above; this case is about the *target* id.
    const response = await call("POST", "/control-plane/keys/cpk_ghost_0001/expire", {
      key: bob,
      scope: KEYS_ROTATE_SCOPE,
      body: { provenKeyId: bob.keyId },
    });
    expect(response.status).toBe(404);
    expect(response.status).not.toBe(400);
    expect((await denial(response)).error.code).toBe("controlplane/key_not_found");
  });
});

describe("token rules", () => {
  test("a token is spendable once — the second presentation is denied against real KV", async () => {
    await connect([registered(alice)]);
    const token = await mint(alice, { scope: MANIFEST_READ_SCOPE });

    expect((await call("GET", "/control-plane/ping", { token })).status).toBe(200);

    const replay = await call("GET", "/control-plane/ping", { token });
    expect(replay.status).toBe(401);
    expect((await denial(replay)).error.code).toBe("controlplane/invalid_credential");
  });

  test("a token minted for one scope cannot be spent on another operation", async () => {
    // Both scopes are granted, so the refusal is about the token: one call, one operation. A token
    // carrying the whole grant would make every call as dangerous as the most dangerous one.
    await connect([registered(alice)]);

    const response = await call("POST", "/control-plane/keys", {
      key: alice,
      scope: MANIFEST_READ_SCOPE,
      body: { keyId: bob.keyId, publicKey: bob.publicKey },
    });
    expect(response.status).toBe(403);
    expect((await denial(response)).error.code).toBe("controlplane/insufficient_scope");
    expect((await persisted()).keys.map((key) => key.keyId)).toEqual(["cpk_alice"]);
  });
});

describe("the error surface", () => {
  test("no denial ever puts `detail` on the wire, whatever the code", async () => {
    // `detail` names the failing verification step, the presented `kid`, the environment a connection is
    // bound to. The HTTP codec strips it, and this is the assertion that the boundary actually holds —
    // across every code the seam can answer with, over the response bytes.
    const seen = new Map<string, string>();
    const record = async (response: Response) => {
      const { text, error } = await denial(response);
      expect(error.detail, `${error.code} leaked detail`).toBeUndefined();
      expect(Object.keys(error), `${error.code} leaked detail`).not.toContain("detail");
      expect(text, `${error.code} leaked detail`).not.toContain("detail");
      // Public copy is still there: an operator reading a client's logs gets a problem and an action.
      expect(error.message.length).toBeGreaterThan(0);
      seen.set(error.code, text);
    };

    // 403 not_connected — before any connection exists.
    await record(await call("GET", "/control-plane/ping", { key: alice, scope: MANIFEST_READ_SCOPE }));

    await connect([registered(alice)]);

    // 401 invalid_credential — signed by a key this connection never registered.
    await record(await call("GET", "/control-plane/ping", { key: bob, scope: MANIFEST_READ_SCOPE }));
    // 403 insufficient_scope — verified caller, wrong scope on the token.
    await record(
      await call("POST", "/control-plane/keys", {
        key: alice,
        scope: MANIFEST_READ_SCOPE,
        body: { keyId: bob.keyId, publicKey: bob.publicKey },
      }),
    );
    // 404 key_not_found — a well-formed id nothing answers to.
    await record(
      await call("POST", "/control-plane/keys/cpk_ghost_0001/expire", {
        key: alice,
        scope: KEYS_ROTATE_SCOPE,
        body: { provenKeyId: alice.keyId },
      }),
    );
    // 409 key_conflict — the lockout refusal.
    await record(
      await call("POST", "/control-plane/keys/cpk_alice/expire", {
        key: alice,
        scope: KEYS_ROTATE_SCOPE,
        body: { provenKeyId: alice.keyId },
      }),
    );

    expect([...seen.keys()].sort()).toEqual([
      "controlplane/insufficient_scope",
      "controlplane/invalid_credential",
      "controlplane/key_conflict",
      "controlplane/key_not_found",
      "controlplane/not_connected",
    ]);
  });
});
