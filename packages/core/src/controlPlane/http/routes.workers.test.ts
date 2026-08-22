// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { InternalError } from "../../error/pithyError";
import { PACKAGE_VERSION } from "../../version.generated";
import { controlplane } from "../capability";
import { ControlPlaneConnection, type Ed25519PublicJwk, type RegisteredKey } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { ControlPlaneManifest } from "../discovery/adminRoute";
import { defineManifestConfig, namedConfigValues } from "../discovery/configuration";
import { defineCapabilityHealth } from "../discovery/health";
import { namedHealthValues } from "../discovery/healthSummary";
import { controlplane_0001_init } from "../migrations/0001_init";
import { KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER, CONTROL_PLANE_VERSION_CREATED_HEADER, CONTROL_PLANE_VERSION_HEADER } from "../wire";
import { requireControlPlane } from "./guard";
import {
  ControlPlaneKeysResponse,
  ControlPlanePingResponse,
  ExpireKeyResponse,
  type PublicKeyView,
  RegisterKeyResponse,
} from "./responses";

/**
 * The seam end to end, in workerd: a real composed backend, real D1, real KV, real Ed25519 tokens.
 *
 * Nothing here is a fixture. Every token is minted with `mintControlPlaneToken` and verified by the
 * same pipeline a deployed Worker runs, against a connection row that went through
 * `ControlPlaneConnection.encode` into the table `controlplane_0001_init` created. So a test
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

/** The scope the health-contributing fixture gates its own read with, and therefore its number too. */
const INVENTORY_READ_SCOPE = "inventory:things:read";

/** What the fixture's producer reports next. Mutable so a case can stand at zero and at three. */
let pending = 0;

/** How many times the producer ran — a caller with no grant must cost the adopter's Worker nothing. */
let produced = 0;

/** The configured fact the inventory fixture states, and the value this composition resolved it to. */
const INVENTORY_UNIT = "crate";

/**
 * A capability that contributes a bounded health summary (#317): one count, behind the scope its own
 * admin route already requires, so a client can render "3 things pending" from the manifest read it
 * already made instead of a second call per number.
 *
 * It also states a configured fact (#422), on the same entry and deliberately so: the two mechanisms
 * look alike and behave nothing alike, and the cases below hold them apart on one capability rather
 * than on two that could differ for some other reason.
 */
const inventory = defineCapability({
  name: "inventory",
  requiredBindings: [],
  manifestConfig: defineManifestConfig({
    keys: [
      {
        key: "unit",
        choices: ["crate", "pallet"],
        summary: "What a thing is counted in, which a client must name back when it files one.",
      },
    ],
    values: { unit: INVENTORY_UNIT },
  }),
  adminRoutes: [
    {
      method: "GET",
      path: "/inventory/admin/things",
      scope: INVENTORY_READ_SCOPE,
      summary: "Every pending thing, in full.",
    },
  ],
  health: defineCapabilityHealth({
    keys: [
      {
        key: "thingsPending",
        kind: "count",
        states: null,
        scope: INVENTORY_READ_SCOPE,
        cost: "memory",
        summary: "Things waiting to be dealt with.",
      },
    ],
    read: async () => {
      produced += 1;
      return { thingsPending: pending };
    },
  }),
  routes: (app) => {
    app.get("/inventory/admin/things", requireControlPlane(INVENTORY_READ_SCOPE), (c) => c.json({ things: [] }));
  },
});

/** The scope the sick fixture gates its own read, and its number, with. */
const VAULT_READ_SCOPE = "vault:secrets:read";

/** Whether the sick fixture's store answers at all. Mutable so one case can stand on each side of it. */
let vaultUp = true;

/** What the sick producer puts in `detail`. Nothing here may appear in any response, ever. */
const VAULT_THROW_DETAIL =
  "D1 SELECT id, name FROM vault_secrets WHERE project = 'acme' failed for connection 4f21 — token sk_live_hunter2";

/**
 * A capability whose health producer fails, the way a store in a customer's data path fails (#350).
 *
 * It throws what a producer *should* throw: client-safe text in `message`, throw-site context in
 * `detail` — a query, a connection id, a token. Every one of those is a thing that must not reach the
 * manifest, a log, or a browser, so the fixture puts them there on purpose and the cases below look for
 * them in the bytes.
 */
const vault = defineCapability({
  name: "vault",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/vault/admin/secrets", scope: VAULT_READ_SCOPE, summary: "Every secret, in full." },
  ],
  health: defineCapabilityHealth({
    keys: [
      {
        key: "secretsDueForRotation",
        kind: "count",
        states: null,
        scope: VAULT_READ_SCOPE,
        cost: "indexed",
        summary: "Secrets past the rotation cadence their registry entry declares.",
      },
    ],
    read: async () => {
      if (vaultUp) return { secretsDueForRotation: 1 };
      throw new InternalError({
        message: "The secret store did not answer.",
        action: "Try again once the store is reachable.",
        detail: VAULT_THROW_DETAIL,
      });
    },
  }),
  routes: (app) => {
    app.get("/vault/admin/secrets", requireControlPlane(VAULT_READ_SCOPE), (c) => c.json({ secrets: [] }));
  },
});

/** One composed backend, exactly as a Worker assembles it. Stateless — every request re-reads D1. */
const backend = createBackend({ capabilities: [controlplane(), quiet, inventory, vault] });

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
    basePath: "/control-plane",
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
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  // The replay set is a table now, not a KV namespace, and it is on the verification path for every
  [alice, bob, carol] = await Promise.all([signer("cpk_alice"), signer("cpk_bob"), signer("cpk_carol")]);
  vaultUp = true;
  pending = 0;
  produced = 0;
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
    // The response is the contract a management client parses, so it parses here too. A field renamed
    // without the schema noticing would break every client and nothing else.
    const raw = await body<unknown>(response);
    expect(() => ControlPlaneManifest.parse(raw)).not.toThrow();
    const json = ControlPlaneManifest.parse(raw);
    expect(json.capabilities.map((capability) => capability.name)).toContain("controlplane");
    expect(json.grantedScopes).toEqual([MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE]);
    expect(json.connectionId).toBe(CONNECTION_ID);
  });

  test("reports both version axes, because neither answers the other's question", async () => {
    // The Cloudflare id says *which build* — the answer for forensics, and what `pithy deploy` verifies.
    // The per-capability package versions say *which features* — the answer for "should this customer
    // upgrade" and "who is exposed to what we just fixed". Reporting one leaves half the questions
    // unanswerable, and they are the halves people actually ask.
    await connect([registered(alice)]);

    const response = await backend.request(
      "http://worker.example/control-plane/manifest",
      { method: "GET", headers: { [CONTROL_PLANE_HEADER]: await mint(alice, { scope: MANIFEST_READ_SCOPE }) } },
      { ...BINDINGS, CF_VERSION_METADATA: { id: "v-deadbeef", tag: "" } },
    );

    const json = ControlPlaneManifest.parse(await body<unknown>(response));
    expect(json.version).toBe("v-deadbeef");
    const seam = json.capabilities.find((capability) => capability.name === "controlplane");
    expect(seam?.version).toBe(PACKAGE_VERSION);
    // Per capability, never aggregated: a project composes some capabilities and not others, so only
    // the intersection of what it composes and what changed is worth reporting.
    const quietDescriptor = json.capabilities.find((capability) => capability.name === "quiet");
    expect(quietDescriptor?.version).toBeNull();
  });

  test("says it cannot tell, rather than inventing a build, with no version binding", async () => {
    await connect([registered(alice)]);
    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(ControlPlaneManifest.parse(await body<unknown>(response)).version).toBeNull();
  });

  test("stamps the running build on every control-plane response, allowed and denied alike", async () => {
    // Per response, not once at connect: a client that captured the version when it connected holds a
    // stale value the moment the adopter deploys, which is precisely when it matters. And on the guard
    // rather than in a handler, so every capability's admin routes carry it too — not only the seam's.
    await connect([registered(alice)]);
    // The shape a real `wrangler dev` hands a Worker: `{ id, tag, timestamp }`, every value a string.
    const bindings = {
      ...BINDINGS,
      CF_VERSION_METADATA: { id: "v-deadbeef", tag: "", timestamp: "2026-08-10T21:39:55.716Z" },
    };

    const allowed = await backend.request(
      "http://worker.example/control-plane/manifest",
      { method: "GET", headers: { [CONTROL_PLANE_HEADER]: await mint(alice, { scope: MANIFEST_READ_SCOPE }) } },
      bindings,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("v-deadbeef");
    // And the timestamp the platform reports for it, so a client comparing the pair can see the same
    // build deployed again — which an id compared against an id never shows. Two headers: the id keeps
    // carrying the id alone, so a client written against it reads exactly what it always did.
    expect(allowed.headers.get(CONTROL_PLANE_VERSION_CREATED_HEADER)).toBe("2026-08-10T21:39:55.716Z");

    // A denial pins the build too. An operator reading a run of refusals needs to know which deploy was
    // refusing them.
    const denied = await backend.request("http://worker.example/control-plane/manifest", { method: "GET" }, bindings);
    expect(denied.status).toBe(401);
    expect(denied.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("v-deadbeef");
    expect(denied.headers.get(CONTROL_PLANE_VERSION_CREATED_HEADER)).toBe("2026-08-10T21:39:55.716Z");
  });

  test("omits both version headers entirely where the binding is absent", async () => {
    // Absent reads as "this Worker cannot say". An empty or invented value would read as one to trust —
    // and this pair is what the first adopter invalidates a cached pane on, so a value it never got must
    // reach it as silence rather than as a string it can compare.
    await connect([registered(alice)]);
    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(response.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBeNull();
    expect(response.headers.get(CONTROL_PLANE_VERSION_CREATED_HEADER)).toBeNull();
  });

  test("says which build without saying when, where the platform gives only the id", async () => {
    // A partial binding is what a platform change looks like from inside a Worker, and it is what every
    // deploy made before this field was read looks like. One header goes silent; the other keeps
    // answering. Dropping both would turn a missing field into "this Worker cannot say" for a question
    // it can still answer.
    await connect([registered(alice)]);
    const response = await backend.request(
      "http://worker.example/control-plane/manifest",
      { method: "GET", headers: { [CONTROL_PLANE_HEADER]: await mint(alice, { scope: MANIFEST_READ_SCOPE }) } },
      { ...BINDINGS, CF_VERSION_METADATA: { id: "v-deadbeef", tag: "" } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("v-deadbeef");
    expect(response.headers.get(CONTROL_PLANE_VERSION_CREATED_HEADER)).toBeNull();
  });

  test("describes how to call each route, not merely that a capability exists", async () => {
    // The whole point of the manifest. Knowing `controlplane` is composed does not tell a client where
    // it is mounted or which scope each route needs — and `basePath` is configurable, so assuming is
    // how a client 404s against every adopter who customized anything.
    await connect([registered(alice)]);

    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    const json = ControlPlaneManifest.parse(await body<unknown>(response));
    const seam = json.capabilities.find((capability) => capability.name === "controlplane");

    expect(seam?.adminRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /control-plane/keys",
      "GET /control-plane/manifest",
      "GET /control-plane/ping",
      "POST /control-plane/keys",
      "POST /control-plane/keys/:keyId/expire",
    ]);
    // Every route says what it needs, so a client can gray out what this connection cannot do rather
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
    const json = ControlPlaneManifest.parse(await body<unknown>(response));
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

describe("the counts a client would otherwise pay a round trip for (#317)", () => {
  /** Read the manifest as a client does — over the wire, then through the schema it publishes. */
  async function manifest(): Promise<ControlPlaneManifest> {
    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(response.status).toBe(200);
    // The whole manifest still parses. A number added to it is worthless if it breaks the contract the
    // client reads everything else through.
    return ControlPlaneManifest.parse(await body<unknown>(response));
  }

  /** One capability's entry, by name. */
  async function entryFor(name: string): Promise<ControlPlaneManifest["capabilities"][number]> {
    const entry = (await manifest()).capabilities.find((capability) => capability.name === name);
    if (!entry) throw new Error(`the fixture capability ${name} is missing from the manifest`);
    return entry;
  }

  test("a granted caller gets the number from the read it already made", async () => {
    await connect([registered(alice)], [MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE]);
    pending = 3;

    const entry = await entryFor("inventory");
    expect(entry.health).toEqual({ state: "reported", values: { thingsPending: 3 } });
    // The declaration travels with it, so a client renders the number with a label it did not ship.
    expect(entry.healthKeys.map((key) => key.key)).toEqual(["thingsPending"]);
    expect(entry.healthKeys[0]?.cost).toBe("memory");
    expect(entry.healthKeys[0]?.scope).toBe(INVENTORY_READ_SCOPE);
  });

  test("zero is a number, and a withheld number is not zero", async () => {
    await connect([registered(alice)], [MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE]);
    pending = 0;
    expect((await entryFor("inventory")).health).toEqual({ state: "reported", values: { thingsPending: 0 } });
  });

  test("a caller without the capability's read scope gets no summary, and costs the Worker nothing", async () => {
    // The distinction the whole design turns on: this connection is not told there is nothing to rotate.
    // It is told nothing, and `healthKeys` says a number exists that it was not granted.
    await connect([registered(alice)], [MANIFEST_READ_SCOPE]);
    pending = 3;
    produced = 0;

    const entry = await entryFor("inventory");
    expect(entry.health).toEqual({ state: "withheld" });
    expect(entry.healthKeys.map((key) => key.key)).toEqual(["thingsPending"]);
    expect(produced).toBe(0);
  });

  test("a capability that contributes nothing declares nothing, which reads as neither", async () => {
    await connect([registered(alice)], [MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE]);

    const plain = await entryFor("quiet");
    expect(plain.healthKeys).toEqual([]);
    expect(plain.health).toEqual({ state: "undeclared" });
  });

  test("a value a client has never heard of renders as nothing rather than as an error", async () => {
    await connect([registered(alice)], [MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE]);
    pending = 3;

    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    const json = await body<{ capabilities: { name: string; health: Record<string, unknown> | null }[] }>(response);
    // What an older client meets when a Worker reports a key its own build predates. The manifest must
    // still parse — a client that failed here would lose its navigation over a number it did not want.
    const newer = json.capabilities.map((capability) =>
      capability.name === "inventory"
        ? { ...capability, health: { ...capability.health, somethingNewer: 9 } }
        : capability,
    );
    const parsed = ControlPlaneManifest.parse({ ...json, capabilities: newer });
    // And pairing values with their declarations drops the one nothing describes, so it renders as
    // nothing rather than as a guess.
    const entry = parsed.capabilities.find((capability) => capability.name === "inventory");
    expect(
      namedHealthValues(entry ?? { healthKeys: [], health: { state: "undeclared" } }).map((named) => named.key.key),
    ).toEqual(["thingsPending"]);
  });

  describe("a sick capability costs its own number and nothing else (#350)", () => {
    test("a producer that throws is `unavailable`, and its sibling still reports its number", async () => {
      // The gate. Before #350 this call was a 500 and Overview went dark for every capability on the
      // manifest, with nothing on screen saying which one had failed.
      await connect([registered(alice)], [MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE, VAULT_READ_SCOPE]);
      vaultUp = false;
      pending = 3;

      const entries = (await manifest()).capabilities;
      const sick = entries.find((capability) => capability.name === "vault");
      const sibling = entries.find((capability) => capability.name === "inventory");

      expect(sick?.health).toEqual({ state: "unavailable" });
      // The sibling's number, unharmed. This is the assertion the whole issue is about.
      expect(sibling?.health).toEqual({ state: "reported", values: { thingsPending: 3 } });
      // And every other entry still resolves too, sick one included — nothing is missing from the list.
      expect(entries.map((capability) => capability.name).sort()).toEqual([
        "controlplane",
        "inventory",
        "quiet",
        "vault",
      ]);
      // Which one failed is on screen: the entry is named, and it carries the declaration of the number
      // that is missing, so a client can say what it cannot show.
      expect(sick?.healthKeys.map((key) => key.key)).toEqual(["secretsDueForRotation"]);
    });

    test("the failed state is not the withheld state and not zero, asserted on the values", async () => {
      // On the values, not on a rendering: three states that each look different in one rendering can
      // still be the same value, and the value is what every consumer branches on.
      await connect([registered(alice)], [MANIFEST_READ_SCOPE, VAULT_READ_SCOPE, INVENTORY_READ_SCOPE]);
      vaultUp = false;
      pending = 0;
      const failed = (await entryFor("vault")).health;
      const zero = (await entryFor("inventory")).health;
      const undeclared = (await entryFor("quiet")).health;

      // The same connection, re-granted nothing but `manifest:read` — so `withheld` here is the real
      // withheld state off the same route, not a value this test built.
      await controlPlaneDatabase(env.DB).deleteFrom(CONTROL_PLANE_CONNECTIONS_TABLE).execute();
      await connect([registered(alice)], [MANIFEST_READ_SCOPE]);
      const withheld = (await entryFor("vault")).health;

      // The inequalities first, so it is the collapse that is caught rather than the state's name. And
      // the states before the values: two capabilities report under different keys, so a failure that
      // fell to zero would still be unequal to a sibling's zero while being exactly as wrong.
      expect(failed.state).not.toBe(zero.state);
      expect(failed.state).not.toBe(withheld.state);
      expect(failed).not.toEqual(zero);
      expect(failed).not.toEqual(withheld);
      expect(failed).not.toEqual(undeclared);
      expect(failed).toEqual({ state: "unavailable" });
      expect(new Set([failed.state, withheld.state, zero.state, undeclared.state]).size).toBe(4);
    });

    test("nothing the producer threw reaches the response bytes", async () => {
      // The security boundary, checked on the bytes rather than on the parse. A producer throws from
      // inside a customer's data path, so its `detail` is a query, a connection id, a token.
      await connect([registered(alice)], [MANIFEST_READ_SCOPE, VAULT_READ_SCOPE]);
      vaultUp = false;

      const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
      expect(response.status).toBe(200);
      const text = await response.text();

      expect(text).not.toContain("sk_live_hunter2");
      expect(text).not.toContain("vault_secrets");
      expect(text).not.toContain(VAULT_THROW_DETAIL);
      // Nor the client-safe half, nor the action: the state carries no words at all, so there is nowhere
      // for a later change to put one.
      expect(text).not.toContain("The secret store did not answer.");
      expect(text).toContain('"healthUnavailable":true');
    });

    test("the same capability reports its number the moment its store answers again", async () => {
      // So the case above is failing for the reason it says, and not because the fixture never worked.
      await connect([registered(alice)], [MANIFEST_READ_SCOPE, VAULT_READ_SCOPE]);
      vaultUp = true;
      expect((await entryFor("vault")).health).toEqual({
        state: "reported",
        values: { secretsDueForRotation: 1 },
      });
    });
  });
});

describe("the configured facts a client must respect (#422)", () => {
  /** The manifest, read as a client reads it — over the wire, then through the schema it publishes. */
  async function entryFor(name: string): Promise<ControlPlaneManifest["capabilities"][number]> {
    const response = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(response.status).toBe(200);
    const entry = ControlPlaneManifest.parse(await body<unknown>(response)).capabilities.find(
      (capability) => capability.name === name,
    );
    if (!entry) throw new Error(`the fixture capability ${name} is missing from the manifest`);
    return entry;
  }

  test("a stated fact reaches the manifest with the declaration that says how to read it", async () => {
    await connect([registered(alice)], [MANIFEST_READ_SCOPE]);

    const entry = await entryFor("inventory");
    expect(entry.configKeys.map((key) => key.key)).toEqual(["unit"]);
    expect(entry.configKeys[0]?.choices).toEqual(["crate", "pallet"]);
    // Read through the pairing rather than off the record, because that is what a client does: a key it
    // has never heard of has no declaration beside it and is not renderable at all.
    expect(namedConfigValues(entry).map((named) => [named.key.key, named.value])).toEqual([["unit", INVENTORY_UNIT]]);
  });

  test("a capability that states nothing reports no facts, which is not the same as no manifest entry", async () => {
    await connect([registered(alice)], [MANIFEST_READ_SCOPE]);

    const plain = await entryFor("quiet");
    expect(plain.configKeys).toEqual([]);
    expect(plain.config).toEqual({});
    expect(namedConfigValues(plain)).toEqual([]);
  });

  test("the fact is the same for every caller, while the number beside it is not", async () => {
    // The property that separates this from health, asserted on one entry so nothing else can explain
    // the difference. A configured fact is what the adopter decided; withholding it from a connection
    // would leave that client guessing the argument to its next call, which is the whole defect.
    await connect([registered(alice)], [MANIFEST_READ_SCOPE]);
    pending = 3;
    const ungranted = await entryFor("inventory");

    await controlPlaneDatabase(env.DB).deleteFrom(CONTROL_PLANE_CONNECTIONS_TABLE).execute();
    await connect([registered(alice)], [MANIFEST_READ_SCOPE, INVENTORY_READ_SCOPE]);
    const granted = await entryFor("inventory");

    expect(ungranted.config).toEqual(granted.config);
    expect(ungranted.configKeys).toEqual(granted.configKeys);
    expect(ungranted.health).toEqual({ state: "withheld" });
    expect(granted.health).toEqual({ state: "reported", values: { thingsPending: 3 } });
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

describe("the exported response schemas against the live routes", () => {
  /**
   * The binding between what a route returns and what a management client is told it returns.
   *
   * Parsing alone would not do it: a Zod object strips unknown keys, so a handler that grew a field
   * would still parse. Comparing the parsed value with the raw body fails in both directions — a field
   * the schema does not know about is dropped and shows as a difference, and a field it declares
   * wrongly fails the parse. `publicKeyView` returned a bare `Record<string, unknown>` before these
   * existed, which is to say the wire shape of the seam's own routes was stated nowhere.
   *
   * A schema that decodes rather than mirrors is compared through its own encoder instead, so the
   * property survives (#350). The manifest's health value is four states on the wire's two fields, and
   * `encode(decode(raw)) === raw` still fails for a field the schema does not know about — it is the
   * same test, made honest about a boundary that now converts.
   */
  async function contract<T>(schema: z.ZodType<T>, response: Response, expected = 200): Promise<T> {
    expect(response.status).toBe(expected);
    const raw = await body<unknown>(response);
    expect(schema.parse(raw)).toEqual(raw);
    return schema.parse(raw);
  }

  test("every route on the seam's own surface returns exactly its declared envelope", async () => {
    await connect([registered(alice)]);

    const ping = await contract(
      ControlPlanePingResponse,
      await call("GET", "/control-plane/ping", { key: alice, scope: MANIFEST_READ_SCOPE }),
    );
    expect(ping.keyId).toBe(alice.keyId);

    // The manifest decodes rather than mirrors — its health value is four states over the wire's two
    // fields (#350) — so the same binding is asserted through the encoder. `encode(decode(raw))` is still
    // `raw` in both directions: a field the schema does not know about is dropped and shows as a
    // difference, and a field it declares wrongly fails the parse.
    const manifestResponse = await call("GET", "/control-plane/manifest", { key: alice, scope: MANIFEST_READ_SCOPE });
    expect(manifestResponse.status).toBe(200);
    const rawManifest = await body<unknown>(manifestResponse);
    expect(ControlPlaneManifest.encode(ControlPlaneManifest.parse(rawManifest))).toEqual(rawManifest);

    await contract(
      ControlPlaneKeysResponse,
      await call("GET", "/control-plane/keys", { key: alice, scope: KEYS_ROTATE_SCOPE }),
    );

    const appended = await contract(
      RegisterKeyResponse,
      await call("POST", "/control-plane/keys", {
        key: alice,
        scope: KEYS_ROTATE_SCOPE,
        body: { keyId: bob.keyId, publicKey: bob.publicKey },
      }),
      201,
    );
    expect(appended.keys.map((key) => key.keyId)).toContain(bob.keyId);

    // Expiry is signed with the successor, because "proof by use" is what the route checks — and a
    // key with a closed window is exactly the case that proves `validUntil` is not always null.
    const expired = await contract(
      ExpireKeyResponse,
      await call("POST", `/control-plane/keys/${alice.keyId}/expire`, {
        key: bob,
        scope: KEYS_ROTATE_SCOPE,
        body: { provenKeyId: bob.keyId },
      }),
    );
    expect(expired.keys.find((key) => key.keyId === alice.keyId)?.validUntil).not.toBeNull();
  });
});
