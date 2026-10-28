// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { AuditEventInput } from "../../audit/auditEvent";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { fixtureConnection, fixtureKey, fixtureTrust } from "../../test-utils/connectionFixtures";
import { controlplane } from "../capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "../data/connection";
import { readConnection } from "../data/connections";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { controlplane_0004_connection_trusts } from "../migrations/0004_connection_trusts";
import { controlplane_0005_holds } from "../migrations/0005_holds";
import { CONNECTIONS_READ_SCOPE, CONNECTIONS_REVOKE_SCOPE, MANIFEST_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER } from "../wire";
import { selfRevokeRefusal } from "./connections";
import { ControlPlaneConnectionsResponse, RevokeConnectionResponse } from "./responses";

/**
 * Listing and revoking connections over the control plane, end to end in workerd: a composed backend, real D1, real
 * Ed25519 tokens.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://app.pithy.sh";
const CONNECTION_ID = "c7a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b";
const SUBJECT = "usr_counsel";
const BINDINGS = { ...env, ENVIRONMENT };

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

const backend = createBackend({
  capabilities: [controlplane(), recorder],
});

let key: { keyId: string; privateKey: CryptoKey; publicKey: Ed25519PublicJwk };

async function connect(scopes: string[]): Promise<void> {
  const now = new Date();
  const connection: ControlPlaneConnection = {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://api.acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "Access review.",
    scopes,
    keys: [
      {
        keyId: key.keyId,
        publicKey: key.publicKey,
        validFrom: new Date(Date.now() - 60_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(ControlPlaneConnection.encode(connection))
    .execute();
}

async function call(method: string, path: string, scope: string, body?: unknown): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: key.privateKey,
    keyId: key.keyId,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: SUBJECT,
    scope,
    body: payload === undefined ? undefined : new TextEncoder().encode(payload),
  });
  const headers: Record<string, string> = { [CONTROL_PLANE_HEADER]: token };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return backend.request(`http://worker.example${path}`, { method, headers, body: payload }, BINDINGS);
}

const ALL = [MANIFEST_READ_SCOPE, CONNECTIONS_READ_SCOPE, CONNECTIONS_REVOKE_SCOPE];

beforeEach(async () => {
  for (const table of ["pithy_controlplane_connections", "pithy_controlplane_replays", "pithy_controlplane_holds"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const migration of [
    controlplane_0001_init,
    controlplane_0002_management_origin,
    controlplane_0003_connection_principal,
    controlplane_0004_connection_trusts,
    controlplane_0005_holds,
  ]) {
    await migration.up(db);
  }
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  key = { keyId: "cpk_counsel", privateKey: pair.privateKey, publicKey: await exportPublicJwk(pair.publicKey) };
  recorded.length = 0;
});

const AGENT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OLD = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
const ELSEWHERE = "3f2504e0-4f89-41d3-9a0c-0305e82c3305";

/** A connection bound to another environment, in the same database. */
async function seedElsewhere(): Promise<void> {
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode(
        fixtureConnection({
          id: ELSEWHERE,
          environment: "staging",
          authorizedBy: "grace@example.com",
          keys: [fixtureKey("k9", { validFrom: new Date(Date.now() - 60_000) })],
        }),
      ),
    )
    .execute();
}

async function seedOthers(): Promise<void> {
  const db = controlPlaneDatabase(env.DB);
  for (const connection of [
    fixtureConnection({
      id: AGENT,
      environment: ENVIRONMENT,
      authorizedBy: "grace@example.com",
      trusts: [fixtureTrust("t1", { validFrom: new Date(Date.now() - 60_000) })],
      keys: [fixtureKey("k1", { validFrom: new Date(Date.now() - 60_000) })],
    }),
    fixtureConnection({ id: OLD, environment: ENVIRONMENT, authorizedBy: null, actorKind: null, purpose: null }),
  ]) {
    await db.insertInto(CONTROL_PLANE_CONNECTIONS_TABLE).values(ControlPlaneConnection.encode(connection)).execute();
  }
}

describe("GET /control-plane/connections", () => {
  test("lists every connection, the unattributed apart, with no key material, behind connections:read", async () => {
    await connect(ALL);
    await seedOthers();
    const response = await call("GET", "/control-plane/connections", CONNECTIONS_READ_SCOPE);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = ControlPlaneConnectionsResponse.parse(JSON.parse(raw));
    expect(body.connections.map((connection) => connection.id).sort()).toEqual([AGENT, CONNECTION_ID].sort());
    expect(body.unattributed.map((connection) => connection.id)).toEqual([OLD]);
    const agent = body.connections.find((connection) => connection.id === AGENT);
    expect(agent).toMatchObject({
      authorizedBy: "grace@example.com",
      actorKind: "agent",
      purpose: "Nightly audit summarizer.",
      credentialKind: "both",
      scopes: ["manifest:read"],
      trusts: [{ trustId: "t1", claims: { repository_id: "1262274726" }, revokedAt: null }],
      live: true,
      revokedAt: null,
    });
    expect(raw).not.toContain(key.publicKey.x);
    expect(raw).not.toContain("publicKey");
  });

  test("filters by principal", async () => {
    await connect(ALL);
    await seedOthers();
    const response = await call(
      "GET",
      "/control-plane/connections?principal=Grace%40example.com",
      CONNECTIONS_READ_SCOPE,
    );
    const body = ControlPlaneConnectionsResponse.parse(await response.json());
    expect(body.connections.map((connection) => connection.id)).toEqual([AGENT]);
    expect(body.unattributed.map((connection) => connection.id)).toEqual([OLD]);
  });

  test("lists only the connections bound to this Worker's environment", async () => {
    await connect(ALL);
    await seedOthers();
    await seedElsewhere();
    const response = await call("GET", "/control-plane/connections", CONNECTIONS_READ_SCOPE);
    const body = ControlPlaneConnectionsResponse.parse(await response.json());
    expect(body.connections.map((connection) => connection.id).sort()).toEqual([AGENT, CONNECTION_ID].sort());
    expect(JSON.stringify(body)).not.toContain(ELSEWHERE);
  });

  test("is refused without connections:read", async () => {
    await connect([MANIFEST_READ_SCOPE]);
    expect((await call("GET", "/control-plane/connections", CONNECTIONS_READ_SCOPE)).status).toBe(403);
  });
});

describe("POST /control-plane/connections/:connectionId/revoke", () => {
  const path = `/control-plane/connections/${AGENT}/revoke`;

  test("revokes the target's live keys and trust and audits the caller, target, principal and reason", async () => {
    await connect(ALL);
    await seedOthers();
    const response = await call("POST", path, CONNECTIONS_REVOKE_SCOPE, { reason: "Grace left the company." });
    expect(response.status).toBe(200);
    const body = RevokeConnectionResponse.parse(await response.json());
    expect(body.revokedKeyIds).toEqual(["k1"]);
    expect(body.revokedTrustIds).toEqual(["t1"]);
    expect(body.connection.live).toBe(false);
    const stored = await readConnection(controlPlaneDatabase(env.DB), AGENT);
    expect(stored?.keys.every((registered) => registered.revokedAt !== null)).toBe(true);
    expect(stored?.trusts?.every((trust) => trust.revokedAt !== null)).toBe(true);
    const event = recorded.find((entry) => entry.action === "controlplane/connection_revoked");
    expect(event).toMatchObject({
      actorType: "control-plane",
      resourceId: AGENT,
      metadata: {
        callerConnectionId: CONNECTION_ID,
        connectionId: AGENT,
        authorizedBy: "grace@example.com",
        reason: "Grace left the company.",
      },
    });
  });

  test("is refused on the caller's own connection", async () => {
    await connect(ALL);
    const response = await call(
      "POST",
      `/control-plane/connections/${CONNECTION_ID}/revoke`,
      CONNECTIONS_REVOKE_SCOPE,
      {
        reason: "Oops.",
      },
    );
    expect(response.status).toBe(409);
    expect((await readConnection(controlPlaneDatabase(env.DB), CONNECTION_ID))?.keys[0]?.revokedAt).toBeNull();
  });

  test("names the environment the caller's own connection ends in, as a person's decision", () => {
    const action = selfRevokeRefusal(CONNECTION_ID, "prod").payload.action ?? "";
    expect(action).toContain("`pithy dashboard disconnect --env prod`");
    expect(action).toContain("a person's decision");
  });

  test("requires a reason", async () => {
    await connect(ALL);
    await seedOthers();
    expect((await call("POST", path, CONNECTIONS_REVOKE_SCOPE, {})).status).toBe(400);
  });

  test("is 404 for an id no connection has", async () => {
    await connect(ALL);
    const response = await call(
      "POST",
      "/control-plane/connections/3f2504e0-4f89-41d3-9a0c-0305e82c3399/revoke",
      CONNECTIONS_REVOKE_SCOPE,
      { reason: "Gone." },
    );
    expect(response.status).toBe(404);
  });

  test("is 404 for a connection bound to another environment, and leaves it live", async () => {
    await connect(ALL);
    await seedElsewhere();
    const response = await call("POST", `/control-plane/connections/${ELSEWHERE}/revoke`, CONNECTIONS_REVOKE_SCOPE, {
      reason: "Not yours.",
    });
    expect(response.status).toBe(404);
    expect((await readConnection(controlPlaneDatabase(env.DB), ELSEWHERE))?.keys[0]?.revokedAt).toBeNull();
    expect(recorded.some((entry) => entry.action === "controlplane/connection_revoked")).toBe(false);
  });

  test("is refused without connections:revoke", async () => {
    await connect([MANIFEST_READ_SCOPE, CONNECTIONS_READ_SCOPE]);
    await seedOthers();
    expect((await call("POST", path, CONNECTIONS_REVOKE_SCOPE, { reason: "No." })).status).toBe(403);
  });
});
