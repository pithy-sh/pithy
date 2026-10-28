// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { describeRoute } from "../../http/routeSpec";
import { MIGRATION_GROUP_TABLE, MIGRATION_TABLE } from "../../migrations/bookkeeping";
import { controlplane } from "../capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { defineCapabilityHealth } from "../discovery/health";
import { requireControlPlane } from "../http/guard";
import { ControlPlaneEvidenceResponse, type EvidenceEntry } from "../http/responses";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { EVIDENCE_READ_SCOPE, MANIFEST_READ_SCOPE, MIGRATIONS_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER } from "../wire";
import { EVIDENCE_CONTROL_IDS, EVIDENCE_MAPPING_VERSION } from "./mapping";

/**
 * The evidence pack end to end, in workerd: a real composed backend, real D1, a real Ed25519 token, and the
 * route a management client calls. The rules for each state are `derive.test.ts`'s; this holds that the Worker
 * reads what it actually composes and records, and that the pack never says more than it found.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://app.pithy.sh";
const CONNECTION_ID = "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b";
const UNATTRIBUTED_ID = "c7b2a1d3-4e5f-4061-9a8b-1c2d3e4f5a6b";
const BINDINGS = { ...env, ENVIRONMENT };

/** The words an auditor uses for a judgment. The pack carries evidence, so none may appear in it or its schema. */
const VERDICT = /compliant|passed|failed/i;

/** A capability shaped like `@pithy-sh/secrets` on the seam: its rotation count behind its own read's scope. */
const SECRETS_STATUS_SCOPE = "secrets:status:read";
const secretsLike = defineCapability({
  name: "secrets",
  requiredBindings: [],
  adminRoutes: [
    {
      method: "GET",
      path: "/secrets/admin/status",
      scope: SECRETS_STATUS_SCOPE,
      kind: "reads",
      summary: "Every secret's status.",
    },
  ],
  health: defineCapabilityHealth({
    keys: [
      {
        key: "secretsDueForRotation",
        kind: "count",
        states: null,
        scope: SECRETS_STATUS_SCOPE,
        cost: "indexed",
        summary: "Secrets past their cadence.",
        nominal: { atMost: 0 },
      },
    ],
    read: async () => ({ secretsDueForRotation: 2 }),
  }),
  routes: (app) => {
    app.get(
      "/secrets/admin/status",
      describeRoute({
        summary: "Read every secret's status.",
        verification: "control-plane",
        scopes: [SECRETS_STATUS_SCOPE],
        responses: { 200: z.object({}).describe("Nothing.") },
      }),
      requireControlPlane(SECRETS_STATUS_SCOPE),
      (c) => c.json({}),
    );
  },
});

/**
 * A capability shaped like `@pithy-sh/audit`: it declares a recorder over its database and, unless `emits` is false,
 * publishes `emit` on every request. With `emits: false` it declares the recorder `composed.ts` reaches for
 * out-of-request events and installs no request seam, so a control-plane call goes unrecorded.
 */
function auditLike(binding: string, { emits = true }: { emits?: boolean } = {}) {
  return defineCapability({
    name: "audit",
    requiredBindings: [],
    databases: { trail: { binding, tables: {} } },
    auditRecorder: () => async () => {},
    middleware: emits
      ? [
          (app) => {
            app.use("*", async (c, next) => {
              c.set("emit", async () => {});
              await next();
            });
          },
        ]
      : [],
  });
}

/** An adopter route that forgot its `describeRoute`. */
const careless = defineCapability({
  name: "careless",
  requiredBindings: [],
  routes: (app) => {
    app.post("/careless/thing", (c) => c.text("ok"));
  },
});

const bare = createBackend({ capabilities: [controlplane()] });
const recorded = createBackend({ capabilities: [controlplane(), auditLike("ANALYTICS"), secretsLike] });
const unseamed = createBackend({ capabilities: [controlplane(), auditLike("ANALYTICS", { emits: false })] });
const undescribed = createBackend({ capabilities: [controlplane(), careless] });

let privateKey: CryptoKey;
let publicKey: Ed25519PublicJwk;

async function connect(id: string, scopes: string[], attributed = true): Promise<void> {
  const now = new Date();
  const connection: ControlPlaneConnection = {
    id,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://api.acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: attributed ? "ada@example.com" : null,
    actorKind: attributed ? "dashboard" : null,
    purpose: attributed ? "Quarterly evidence for the auditor." : null,
    scopes,
    keys: [
      {
        keyId: "cpk_alice",
        publicKey,
        validFrom: new Date(now.getTime() - 3 * 86_400_000),
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

/** Any composed backend: the pack is read the same way off each. */
type Worker = {
  request: (url: string, init: RequestInit, bindings: Record<string, unknown>) => Response | Promise<Response>;
};

async function read(worker: Worker, scope = EVIDENCE_READ_SCOPE): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey,
    keyId: "cpk_alice",
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "usr_auditor",
    scope,
  });
  return worker.request(
    "http://worker.example/control-plane/evidence",
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    BINDINGS,
  );
}

/** The pack, parsed with its own exported schema and held equal to the raw body, so no field goes unnamed. */
async function pack(worker: Worker): Promise<ControlPlaneEvidenceResponse> {
  const response = await read(worker);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toMatch(VERDICT);
  const raw = JSON.parse(text) as unknown;
  const parsed = ControlPlaneEvidenceResponse.parse(raw);
  expect(parsed).toEqual(raw);
  return parsed;
}

function control(body: ControlPlaneEvidenceResponse, id: EvidenceEntry["control"]): EvidenceEntry {
  const entry = body.controls.find((candidate) => candidate.control === id);
  if (!entry) throw new Error(`no ${id} in the pack`);
  return entry;
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  for (const database of [env.DB, env.ANALYTICS]) {
    await database.prepare(`drop table if exists ${MIGRATION_GROUP_TABLE}`).run();
    await database.prepare(`drop table if exists ${MIGRATION_TABLE}`).run();
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  await controlplane_0002_management_origin.up(db);
  await controlplane_0003_connection_principal.up(db);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKey = await exportPublicJwk(pair.publicKey);
});

describe("GET /control-plane/evidence (#821)", () => {
  test("is refused to a connection without evidence:read", async () => {
    await connect(CONNECTION_ID, [MANIFEST_READ_SCOPE]);
    const response = await read(bare);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("controlplane/insufficient_scope");
  });

  test("answers every control in the table, in its order, with the mapping version on the pack", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const body = await pack(bare);
    expect(body.mappingVersion).toBe(EVIDENCE_MAPPING_VERSION);
    expect(body.environment).toBe(ENVIRONMENT);
    expect(body.controls.map((entry) => entry.control)).toEqual([...EVIDENCE_CONTROL_IDS]);
    for (const entry of body.controls) {
      expect(entry.soc2.length, entry.control).toBeGreaterThan(0);
      expect(entry.iso27001.length, entry.control).toBeGreaterThan(0);
      for (const fact of entry.facts) expect(fact.source, `${entry.control}.${fact.fact}`).toBeTruthy();
      if (entry.state !== "evidenced") expect(entry.reasons.length, entry.control).toBeGreaterThan(0);
    }
  });

  test("a Worker without audit composed reports logging as a gap naming the capability", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const logging = control(await pack(bare), "audit-logging");
    expect(logging.state).toBe("gap");
    expect(logging.reasons.join(" ")).toContain("@pithy-sh/audit");
  });

  test("a composed recorder, its binding present and on the request's emit seam, is evidenced", async () => {
    // A recorder whose binding is missing never gets this far: the Worker refuses every request for a missing
    // required binding. `pack.workers.test.ts` holds what the pack says when one is absent. The next case holds
    // that this one is evidenced because the recorder publishes `emit`, not because the gate wrapped it.
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const logging = control(await pack(recorded), "audit-logging");
    expect(logging.state).toBe("evidenced");
    expect(logging.facts).toEqual([
      { fact: "auditRecorder", value: "audit", source: "composition" },
      { fact: "bindingPresent", subject: "ANALYTICS", value: true, source: "bindings" },
      { fact: "controlPlaneCallsRecorded", value: true, source: "auditRecorder" },
    ]);
  });

  test("a composed recorder off the request's emit seam is a gap, on a connection whose kind the gate stamps", async () => {
    // The connection carries an actor kind, so the gate wraps the request's emit to stamp it. Wrapping the no-op
    // must not make the pack read it as a recorder: nothing records this call.
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const logging = control(await pack(unseamed), "audit-logging");
    expect(logging.state).toBe("gap");
    expect(logging.facts).toContainEqual({ fact: "controlPlaneCallsRecorded", value: false, source: "auditRecorder" });
    expect(logging.reasons.join(" ")).toContain("emit seam");
  });

  test("reads every route's declared verification off the composed table, and names one that declares none", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const described = control(await pack(bare), "route-verification");
    expect(described.state).toBe("evidenced");
    expect(described.facts).toContainEqual({
      fact: "routesVerifiedBy",
      subject: "control-plane",
      value: expect.any(Number),
      source: "routeSpec",
    });
    const careless = control(await pack(undescribed), "route-verification");
    expect(careless.state).toBe("gap");
    expect(careless.reasons).toContain("`POST /careless/thing` declares no verification.");
  });

  test("lists every connection's principal, kind, purpose and grant, and names one registered before them", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const attributed = control(await pack(bare), "management-access");
    expect(attributed.state).toBe("evidenced");
    expect(attributed.facts).toContainEqual({
      fact: "authorizedBy",
      subject: CONNECTION_ID,
      value: "ada@example.com",
      source: "connection",
    });
    expect(attributed.facts).toContainEqual({
      fact: "scopes",
      subject: CONNECTION_ID,
      value: [EVIDENCE_READ_SCOPE],
      source: "connection",
    });

    await connect(UNATTRIBUTED_ID, [MANIFEST_READ_SCOPE], false);
    const unattributed = control(await pack(bare), "management-access");
    expect(unattributed.state).toBe("gap");
    expect(unattributed.reasons.join(" ")).toContain(UNATTRIBUTED_ID);
  });

  test("never carries key material: ages and counts only", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const text = await (await read(bare)).text();
    expect(text).not.toContain(publicKey.x);
    const rotation = control(ControlPlaneEvidenceResponse.parse(JSON.parse(text)), "key-rotation");
    expect(rotation.facts).toContainEqual({
      fact: "oldestLiveKeyAgeDays",
      subject: CONNECTION_ID,
      value: 3,
      source: "connectionKeys",
    });
  });

  test("a scope withheld from the Worker's own reads is not-derivable, never evidenced", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const body = await pack(recorded);
    const history = control(body, "change-history");
    expect(history.state).toBe("not-derivable");
    expect(history.reasons.join(" ")).toContain(MIGRATIONS_READ_SCOPE);
    expect(history.facts).toEqual([]);
    const rotation = control(body, "key-rotation");
    expect(rotation.state).toBe("not-derivable");
    expect(rotation.reasons.join(" ")).toContain(SECRETS_STATUS_SCOPE);
  });

  test("granted the scopes behind them, the same reads report what they hold", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE, MIGRATIONS_READ_SCOPE, SECRETS_STATUS_SCOPE]);
    const body = await pack(recorded);
    const history = control(body, "change-history");
    // Nothing is applied on a fresh database, so this build's own migrations are pending: a gap, named.
    expect(history.state).toBe("gap");
    expect(history.facts).toContainEqual({ fact: "pending", subject: "app", value: 5, source: "migrationLedger" });
    const rotation = control(body, "key-rotation");
    expect(rotation.state).toBe("gap");
    expect(rotation.facts).toContainEqual({
      fact: "secretsDueForRotation",
      subject: "secrets",
      value: 2,
      source: "capabilityHealth",
    });
  });

  test("without a privacy attestation, data protection cannot be compared and says why", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const data = control(await pack(bare), "data-protection");
    expect(data.state).toBe("not-derivable");
    expect(data.reasons.join(" ")).toContain("attestation");
  });

  test("with no route taking a session cookie, nothing needs a same-origin policy", async () => {
    await connect(CONNECTION_ID, [EVIDENCE_READ_SCOPE]);
    const csrf = control(await pack(bare), "csrf");
    expect(csrf.state).toBe("evidenced");
    expect(csrf.facts).toContainEqual({ fact: "sessionRoutes", value: 0, source: "routeSpec" });
  });
});
