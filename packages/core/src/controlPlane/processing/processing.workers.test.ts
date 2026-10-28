// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { type Capability, defineCapability } from "../../capability/capability";
import { ConsentPurpose } from "../../consent/purpose";
import { createBackend } from "../../createBackend";
import { createDatabase } from "../../data/db";
import { phi, pii } from "../../privacy/classes";
import { forgetProcessing } from "../../processing/composed";
import { forgetRetention } from "../../retention/composed";
import { controlplane } from "../capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { ControlPlaneProcessingResponse } from "../http/responses";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { EVIDENCE_READ_SCOPE, MANIFEST_READ_SCOPE, PRIVACY_READ_SCOPE, PROCESSING_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER } from "../wire";

/**
 * The processing record end to end, in workerd: a composed backend, real D1, a real Ed25519 token, and the route a
 * management client calls. The rules for each gap are `derive.test.ts`'s; this holds that the Worker reads what it
 * actually composes, declares and records.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://app.pithy.sh";
const CONNECTION_ID = "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b";
const BINDINGS = { ...env, ENVIRONMENT };

/** A capability shaped like auth: a classed table, and the activity that uses it. */
const accounts = defineCapability({
  name: "accounts",
  requiredBindings: [],
  databases: {
    app: {
      binding: "DB",
      tables: { pithyAccountsUsers: z.object({ email: pii(z.string().describe("Email.")) }).describe("A user.") },
    },
  },
  processing: [{ id: "accounts.account", purpose: "Keep an account.", classes: ["pii"], legalBasis: "contract" }],
});

/** A capability that stores health data and declares nothing about it. */
const clinic = defineCapability({
  name: "clinic",
  requiredBindings: [],
  databases: {
    app: {
      binding: "DB",
      tables: { clinicPatients: z.object({ history: phi(z.string().describe("History.")) }).describe("A patient.") },
    },
  },
});

/** A capability shaped like vector: it needs Workers AI. */
const embedder = defineCapability({ name: "embedder", requiredBindings: [{ type: "ai", name: "AI" }] });

const records = ConsentPurpose.parse({
  id: "consent.records",
  summary: "Keep my record.",
  noticeVersion: 1,
  classes: ["phi"],
});

/** A capability shaped like `@pithy-sh/consent`: the seam's reader, with standings. */
function consentLike(standing: number): Capability {
  return defineCapability({
    name: "consent",
    requiredBindings: [],
    consentReader: () => ({
      hasConsent: async () => standing > 0,
      standings: async () => [{ purpose: records, grants: standing + 1, withdrawals: 1, standing }],
    }),
  });
}

/** A consent reader whose catalog is held in memory and whose record cannot be read. */
const consentDown = defineCapability({
  name: "consent",
  requiredBindings: [],
  consentReader: () => ({
    hasConsent: async () => false,
    purposes: () => [records],
    standings: async () => {
      throw new Error("D1_ERROR: the database is unavailable");
    },
  }),
});

let privateKey: CryptoKey;
let publicKey: Ed25519PublicJwk;

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
    purpose: "The Article 30 record.",
    scopes,
    keys: [
      {
        keyId: "cpk_alice",
        publicKey,
        validFrom: new Date(now.getTime() - 86_400_000),
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

type Worker = {
  request: (url: string, init: RequestInit, bindings: Record<string, unknown>) => Response | Promise<Response>;
};

async function read(worker: Worker, bindings: Record<string, unknown> = BINDINGS): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey,
    keyId: "cpk_alice",
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "usr_dpo",
    scope: PROCESSING_READ_SCOPE,
  });
  return worker.request(
    "http://worker.example/control-plane/processing",
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    bindings,
  );
}

/** The record, parsed with its own exported schema and held equal to the raw body, so no field goes unnamed. */
async function record(worker: Worker, bindings?: Record<string, unknown>): Promise<ControlPlaneProcessingResponse> {
  const response = await read(worker, bindings);
  expect(response.status).toBe(200);
  const raw = (await response.json()) as unknown;
  const parsed = ControlPlaneProcessingResponse.parse(raw);
  expect(parsed).toEqual(raw);
  return parsed;
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  await controlplane_0002_management_origin.up(db);
  await controlplane_0003_connection_principal.up(db);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKey = await exportPublicJwk(pair.publicKey);
});

afterEach(() => {
  forgetProcessing();
  forgetRetention();
});

describe("GET /control-plane/processing", () => {
  test("is refused to a connection without processing:read", async () => {
    await connect([MANIFEST_READ_SCOPE]);
    const response = await read(createBackend({ capabilities: [controlplane(), accounts] }));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("controlplane/insufficient_scope");
  });

  test("lists a capability's activity and the adopter's, with the basis the config states and its retention", async () => {
    await connect([PROCESSING_READ_SCOPE]);
    const worker = createBackend({
      capabilities: [controlplane(), accounts, clinic],
      retention: { classAges: { pii: "3y" } },
      processing: {
        activities: [{ id: "acme.care", purpose: "Treat patients.", classes: ["phi"] }],
        overrides: { "accounts.account": { legalBasis: "legitimate-interests" } },
      },
    });
    const body = await record(worker);
    expect(body.environment).toBe(ENVIRONMENT);
    expect(body.activities.map((entry) => [entry.id, entry.declaredBy, entry.legalBasis, entry.basisSource])).toEqual([
      ["accounts.account", "accounts", "legitimate-interests", "config"],
      ["acme.care", "config", null, null],
    ]);
    expect(body.activities[0]?.retention?.classAges).toEqual([{ class: "pii", days: 1095 }]);
    expect(body.activities[1]?.gaps.map((gap) => gap.kind)).toEqual(["no-legal-basis"]);
    expect(body.activities[0]?.recipients[0]).toMatchObject({ name: "Cloudflare", source: "platform" });
  });

  test("names stored phi that no consent purpose covers, and a covering purpose with no standing grant", async () => {
    await connect([PROCESSING_READ_SCOPE, PRIVACY_READ_SCOPE]);
    const uncovered = await record(createBackend({ capabilities: [controlplane(), accounts, clinic] }));
    expect(uncovered.gaps).toContainEqual({
      kind: "phi-not-covered",
      subject: "clinic/clinicPatients.history",
      detail: expect.any(String),
    });
    expect(uncovered.gaps).toContainEqual({
      kind: "class-unclaimed",
      subject: "clinic",
      detail: expect.stringContaining("phi"),
    });

    const grantless = await record(createBackend({ capabilities: [controlplane(), accounts, clinic, consentLike(0)] }));
    expect(grantless.gaps.map((gap) => gap.kind)).not.toContain("phi-not-covered");
    expect(grantless.gaps).toContainEqual({
      kind: "no-standing-grant",
      subject: "consent.records",
      detail: expect.any(String),
    });
  });

  test("without privacy:read, a gap names the capability and never a table or a field", async () => {
    await connect([PROCESSING_READ_SCOPE]);
    const body = await record(createBackend({ capabilities: [controlplane(), accounts, clinic] }));
    expect(body.gaps).toContainEqual({ kind: "phi-not-covered", subject: "clinic", detail: expect.any(String) });
    expect(body.gaps).toContainEqual({
      kind: "class-unclaimed",
      subject: "clinic",
      detail: expect.stringContaining("phi"),
    });
    expect(JSON.stringify(body)).not.toMatch(/clinicPatients|history|pithyAccountsUsers/);
  });

  test("an unreadable consent record keeps the catalog, so an activity on its purpose reports no false gap", async () => {
    await connect([PROCESSING_READ_SCOPE]);
    const worker = createBackend({
      capabilities: [controlplane(), accounts, clinic, consentDown],
      processing: {
        activities: [
          {
            id: "acme.care",
            purpose: "Treat patients.",
            classes: ["phi"],
            legalBasis: "consent",
            consentPurpose: "consent.records",
          },
        ],
      },
    });
    const body = await record(worker);
    const care = body.activities.find((entry) => entry.id === "acme.care");
    expect(care?.gaps).toEqual([]);
    expect(care?.consent).toMatchObject({ purpose: "consent.records", noticeVersion: 1, grants: null });
    expect(body.gaps.map((gap) => gap.kind)).not.toContain("phi-not-covered");
    expect(body.notDerivable.join(" ")).toMatch(/consent record/);
  });

  test("a consent-based activity cites its purpose and the reader's grant counts", async () => {
    await connect([PROCESSING_READ_SCOPE]);
    const worker = createBackend({
      capabilities: [controlplane(), accounts, clinic, consentLike(4)],
      processing: {
        activities: [
          {
            id: "acme.care",
            purpose: "Treat patients.",
            classes: ["phi"],
            legalBasis: "consent",
            consentPurpose: "consent.records",
          },
        ],
      },
    });
    const care = (await record(worker)).activities.find((entry) => entry.id === "acme.care");
    expect(care?.consent).toEqual({
      purpose: "consent.records",
      noticeVersion: 1,
      explicit: false,
      grants: 5,
      withdrawals: 1,
      standing: 4,
    });
    expect(care?.gaps).toEqual([]);
  });

  test("names Workers AI where its binding is bound", async () => {
    await connect([PROCESSING_READ_SCOPE]);
    const worker = createBackend({ capabilities: [controlplane(), accounts, embedder] });
    const body = await record(worker, { ...BINDINGS, AI: {} });
    expect(body.recipients.map((recipient) => [recipient.name, recipient.source])).toEqual([
      ["Cloudflare", "platform"],
      ["Cloudflare Workers AI", "binding"],
    ]);
  });

  test("cites the evidence pack's states only for a connection that may read the pack", async () => {
    await connect([PROCESSING_READ_SCOPE]);
    const worker = createBackend({ capabilities: [controlplane(), accounts] });
    expect((await record(worker)).measures.every((measure) => measure.state === null)).toBe(true);

    await env.DB.exec("DELETE FROM pithy_controlplane_connections");
    await connect([PROCESSING_READ_SCOPE, EVIDENCE_READ_SCOPE]);
    const measures = (await record(worker)).measures;
    expect(measures.find((measure) => measure.control === "audit-logging")?.state).toBe("gap");
    expect(measures.every((measure) => measure.state !== null)).toBe(true);
  });
});
