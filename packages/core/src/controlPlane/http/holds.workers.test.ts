// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { AuditEventInput } from "../../audit/auditEvent";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { legalHolds } from "../../retention/holds";
import { controlplane } from "../capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { ControlPlaneManifest } from "../discovery/adminRoute";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { controlplane_0004_connection_trusts } from "../migrations/0004_connection_trusts";
import { controlplane_0005_holds } from "../migrations/0005_holds";
import { MANIFEST_READ_SCOPE, RETENTION_HOLD_SCOPE, RETENTION_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER } from "../wire";
import { ControlPlaneHoldResponse, ControlPlaneHoldsResponse } from "./responses";

/**
 * Legal holds over the control plane, end to end in workerd: a composed backend, real D1, real Ed25519 tokens.
 * Placing and releasing are each behind `retention:hold` and audited; listing is behind `retention:read`; the manifest
 * carries the count of standing holds behind the same read, and the effective retention beside it.
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
  retention: { audit: { default: "90d" }, classAges: { pii: "3y" } },
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
    purpose: "Legal holds.",
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

const ALL = [MANIFEST_READ_SCOPE, RETENTION_HOLD_SCOPE, RETENTION_READ_SCOPE];

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

async function place(body: unknown): Promise<Response> {
  return call("POST", "/control-plane/holds", RETENTION_HOLD_SCOPE, body);
}

describe("POST /control-plane/holds", () => {
  test("places a hold with its reason, behind retention:hold, and audits it", async () => {
    await connect(ALL);
    const response = await place({ subjectType: "user", subjectId: "usr_1", reason: "Litigation hold, case 42." });
    expect(response.status).toBe(201);
    const { hold } = ControlPlaneHoldResponse.parse(await response.json());
    expect(hold).toMatchObject({ subjectType: "user", subjectId: "usr_1", state: "active", placedBy: SUBJECT });
    expect(await legalHolds(BINDINGS).held("user", "usr_1")).toBe(true);
    expect(await legalHolds(BINDINGS).held("user", "usr_2")).toBe(false);
    expect(recorded).toContainEqual(
      expect.objectContaining({
        action: "controlplane/hold_placed",
        actorType: "control-plane",
        actorId: SUBJECT,
        resourceType: "user",
        resourceId: "usr_1",
        metadata: { holdId: hold.id, subjectType: "user", reason: "Litigation hold, case 42." },
      }),
    );
  });

  test("holds a tenant's audit trail, or the untenanted one with a null id", async () => {
    await connect(ALL);
    expect((await place({ subjectType: "audit", subjectId: "org_1", reason: "Regulator request." })).status).toBe(201);
    expect((await place({ subjectType: "audit", subjectId: null, reason: "Regulator request." })).status).toBe(201);
    expect(await legalHolds(BINDINGS).held("audit", "org_1")).toBe(true);
    expect(await legalHolds(BINDINGS).held("audit", null)).toBe(true);
  });

  test("refuses a hold with no reason, or a user hold naming nobody", async () => {
    await connect(ALL);
    expect((await place({ subjectType: "user", subjectId: "usr_1", reason: "  " })).status).toBe(400);
    expect((await place({ subjectType: "user", subjectId: null, reason: "Why." })).status).toBe(400);
  });

  test("refuses a field that would shorten a retention", async () => {
    await connect(ALL);
    const response = await place({ subjectType: "user", subjectId: "usr_1", reason: "Why.", purgeAfterDays: 1 });
    expect(response.status).toBe(400);
  });

  test("is refused to a connection granted only retention:read", async () => {
    await connect([MANIFEST_READ_SCOPE, RETENTION_READ_SCOPE]);
    const response = await place({ subjectType: "user", subjectId: "usr_1", reason: "Why." });
    expect(response.status).toBe(403);
  });
});

describe("POST /control-plane/holds/:holdId/release", () => {
  test("releases a hold with a reason, audits it, and keeps it as a record", async () => {
    await connect(ALL);
    const placed = ControlPlaneHoldResponse.parse(
      await (await place({ subjectType: "organization", subjectId: "org_1", reason: "Dispute." })).json(),
    ).hold;
    const response = await call("POST", `/control-plane/holds/${placed.id}/release`, RETENTION_HOLD_SCOPE, {
      reason: "Settled.",
    });
    expect(response.status).toBe(200);
    const { hold } = ControlPlaneHoldResponse.parse(await response.json());
    expect(hold).toMatchObject({ state: "released", releasedBy: SUBJECT, releaseReason: "Settled." });
    expect(await legalHolds(BINDINGS).held("organization", "org_1")).toBe(false);
    expect(recorded.map((event) => event.action).filter((action) => action.includes("hold"))).toEqual([
      "controlplane/hold_placed",
      "controlplane/hold_released",
    ]);

    const again = await call("POST", `/control-plane/holds/${placed.id}/release`, RETENTION_HOLD_SCOPE, {
      reason: "Twice.",
    });
    expect(again.status).toBe(409);
  });

  test("an unknown hold is a 404, and a release needs a reason", async () => {
    await connect(ALL);
    expect(
      (await call("POST", "/control-plane/holds/nope/release", RETENTION_HOLD_SCOPE, { reason: "Why." })).status,
    ).toBe(404);
    expect((await call("POST", "/control-plane/holds/nope/release", RETENTION_HOLD_SCOPE, {})).status).toBe(400);
  });
});

describe("GET /control-plane/holds", () => {
  test("lists holds behind retention:read, standing first, with the count", async () => {
    await connect(ALL);
    const first = ControlPlaneHoldResponse.parse(
      await (await place({ subjectType: "user", subjectId: "usr_1", reason: "One." })).json(),
    ).hold;
    await place({ subjectType: "user", subjectId: "usr_2", reason: "Two." });
    await call("POST", `/control-plane/holds/${first.id}/release`, RETENTION_HOLD_SCOPE, { reason: "Done." });

    const response = await call("GET", "/control-plane/holds", RETENTION_READ_SCOPE);
    expect(response.status).toBe(200);
    const listed = ControlPlaneHoldsResponse.parse(await response.json());
    expect(listed.active).toBe(1);
    expect(listed.holds.map((hold) => [hold.subjectId, hold.state])).toEqual([
      ["usr_2", "active"],
      ["usr_1", "released"],
    ]);

    const released = ControlPlaneHoldsResponse.parse(
      await (await call("GET", "/control-plane/holds?state=released", RETENTION_READ_SCOPE)).json(),
    );
    expect(released.holds.map((hold) => hold.subjectId)).toEqual(["usr_1"]);
  });

  test("is refused to a connection granted only retention:hold", async () => {
    await connect([RETENTION_HOLD_SCOPE]);
    expect((await call("GET", "/control-plane/holds", RETENTION_READ_SCOPE)).status).toBe(403);
  });
});

describe("the manifest", () => {
  test("carries the effective retention and, behind retention:read, the count of standing holds", async () => {
    await connect(ALL);
    await place({ subjectType: "user", subjectId: "usr_1", reason: "One." });
    const manifest = ControlPlaneManifest.parse(
      await (await call("GET", "/control-plane/manifest", MANIFEST_READ_SCOPE)).json(),
    );
    expect(manifest.retention?.audit.defaultDays).toBe(90);
    expect(manifest.retention?.audit.rules).toContainEqual({ prefix: "controlplane/", days: 365, source: "floor" });
    expect(manifest.retention?.classAges).toEqual([{ class: "pii", days: 1095 }]);
    const seam = manifest.capabilities.find((capability) => capability.name === "controlplane");
    expect(JSON.stringify(seam?.health)).toContain('"activeHolds"');
    expect(seam?.health).toMatchObject({ state: "reported" });
    expect((seam?.health as { values?: Record<string, unknown> } | undefined)?.values?.activeHolds).toBe(1);
  });

  test("withholds the hold count from a connection without retention:read", async () => {
    await connect([MANIFEST_READ_SCOPE]);
    const manifest = ControlPlaneManifest.parse(
      await (await call("GET", "/control-plane/manifest", MANIFEST_READ_SCOPE)).json(),
    );
    const seam = manifest.capabilities.find((capability) => capability.name === "controlplane");
    expect((seam?.health as { values?: Record<string, unknown> } | undefined)?.values?.activeHolds ?? null).toBeNull();
  });
});

describe("legalHolds", () => {
  test("reads a database no control plane ever migrated as holding nothing", async () => {
    await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_holds");
    expect(await legalHolds(BINDINGS).held("user", "usr_1")).toBe(false);
  });

  test("reads an env with no app database as holding nothing", async () => {
    expect(await legalHolds({}).held("user", "usr_1")).toBe(false);
  });
});
