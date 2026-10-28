// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { type AuditEmit, noopEmit } from "../../audit/recorder";
import { type Capability, defineCapability, type PithyHonoEnv } from "../../capability/capability";
import { createDatabase } from "../../data/db";
import { createLogger } from "../../logger/logger";
import type { LogRecord } from "../../logger/record";
import type { ControlPlaneContext } from "../context";
import { ControlPlaneConnection } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../data/tables";
import { capabilityHealthSources, defineCapabilityHealth } from "../discovery/health";
import { ControlPlaneEvidenceResponse, type EvidenceEntry } from "../http/responses";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { EVIDENCE_READ_SCOPE } from "../scope/scope";
import { type EvidenceSources, readEvidencePack } from "./pack";

/**
 * `readEvidencePack` called directly, with hand-built sources, so its own reads can be made to fail: the
 * route cannot reach these, because the gate reads the connections table before the pack does. It holds the
 * module's two promises — a failed read costs its controls their answer and never the pack, and a cause goes to the
 * log and never into the pack — and that management access lists this environment's connections only.
 */

const ENVIRONMENT = "production";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const D1_CAUSE = "D1_ERROR: no such table pithy_controlplane_connections";

const CONTEXT: ControlPlaneContext = {
  connectionId: "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b",
  environment: ENVIRONMENT,
  issuer: "https://app.pithy.sh",
  subject: "usr_auditor",
  scope: EVIDENCE_READ_SCOPE,
  grantedScopes: [EVIDENCE_READ_SCOPE],
  keyId: "cpk_alice",
  tokenId: "jti_1",
  actorKind: "dashboard",
};

/** Sources that read nothing but the real D1 connections table. Each case overrides the one it makes fail. */
function sources(overrides: Partial<EvidenceSources> = {}): EvidenceSources {
  return {
    composition: () => [],
    composedHealth: () => new Map(),
    composedMigrations: () => [],
    privacyInventory: () => ({
      sources: ["d1", "kv"],
      schemasWalked: 0,
      schemas: [],
      counts: {},
      observed: [],
      encryptedFields: 0,
      unrotatable: 0,
    }),
    retirement: async () => ({ blocked: false, reasons: [], liveVersions: 0 }),
    routeGroups: () => undefined,
    database: () => controlPlaneDatabase(env.DB),
    now: () => NOW,
    ...overrides,
  };
}

/** What the request around the pack carries: the caller, the emit seam, and the Worker's bindings. */
interface RequestShape {
  context?: ControlPlaneContext;
  emit?: AuditEmit;
  bindings?: Record<string, unknown>;
}

/** Run the pack inside a request, as the route does, and return it serialized with the warnings it logged. */
async function readPack(
  given: EvidenceSources,
  { context = CONTEXT, emit = noopEmit, bindings = {} }: RequestShape = {},
): Promise<{ text: string; body: ControlPlaneEvidenceResponse; logged: LogRecord[] }> {
  const logged: LogRecord[] = [];
  const app = new Hono<PithyHonoEnv>();
  app.use("*", async (c, next) => {
    c.set("log", createLogger({ level: "debug", sink: (record) => logged.push(record) }));
    c.set("emit", emit);
    c.set("sameOrigin", null);
    await next();
  });
  app.get("/evidence", async (c) => c.json(await readEvidencePack(c, given, context)));
  const response = await app.request("/evidence", {}, { ENVIRONMENT, ...bindings });
  expect(response.status).toBe(200);
  const text = await response.text();
  return { text, body: ControlPlaneEvidenceResponse.parse(JSON.parse(text)), logged };
}

function control(body: ControlPlaneEvidenceResponse, id: EvidenceEntry["control"]): EvidenceEntry {
  const entry = body.controls.find((candidate) => candidate.control === id);
  if (!entry) throw new Error(`no ${id} in the pack`);
  return entry;
}

/** A recorder over the given databases, each named by its binding, shaped like `@pithy-sh/audit`. */
function recorder(databases: Record<string, string>): Capability {
  return defineCapability({
    name: "audit",
    requiredBindings: [],
    databases: Object.fromEntries(Object.entries(databases).map(([name, binding]) => [name, { binding, tables: {} }])),
    auditRecorder: () => async () => {},
  });
}

/** A request emit seam that is not the no-op: what a composed recorder's middleware publishes. */
const recording: AuditEmit = async () => {};

const SECRETS_STATUS_SCOPE = "secrets:status:read";

/** A capability shaped like `@pithy-sh/secrets`: one overdue secret, behind its own read's scope. */
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
    read: async () => ({ secretsDueForRotation: 1 }),
  }),
});

/** Sources composing the secrets stand-in, with its health gathered exactly as the seam gathers it. */
function withSecrets(): Partial<EvidenceSources> {
  return {
    composition: () => [secretsLike],
    composedHealth: () => capabilityHealthSources([secretsLike]),
  };
}

async function register(id: string, environment: string, authorizedBy: string): Promise<void> {
  const now = new Date();
  const connection: ControlPlaneConnection = {
    id,
    environment,
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy,
    actorKind: "dashboard",
    purpose: "Quarterly evidence for the auditor.",
    scopes: [EVIDENCE_READ_SCOPE],
    keys: [
      {
        keyId: `cpk_${id.slice(0, 4)}`,
        publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
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

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  await controlplane_0002_management_origin.up(db);
  await controlplane_0003_connection_principal.up(db);
});

describe("readEvidencePack (#821)", () => {
  test("an unreadable connections table costs the controls that read it their answer, and never names the cause", async () => {
    const { text, body, logged } = await readPack(
      sources({
        database: () => {
          throw new Error(D1_CAUSE);
        },
      }),
    );
    for (const id of ["management-access", "key-rotation"] as const) {
      const entry = control(body, id);
      expect(entry.state, id).toBe("not-derivable");
      expect(entry.reasons.join(" "), id).toContain(
        "The control-plane connections table could not be read on this call.",
      );
    }
    // The rest of the pack still answers.
    expect(control(body, "audit-logging").state).toBe("gap");
    expect(text).not.toContain("D1_ERROR");
    expect(text).not.toContain("no such table");
    // The cause goes to the Worker's log, for the operator.
    expect(JSON.stringify(logged)).toContain(D1_CAUSE);
  });

  test("a query that rejects, rather than a database that throws, is caught the same way", async () => {
    await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
    const { text, body } = await readPack(sources());
    expect(control(body, "management-access").state).toBe("not-derivable");
    expect(control(body, "key-rotation").state).toBe("not-derivable");
    expect(text).not.toMatch(/D1_ERROR|SQLITE|no such table/i);
  });

  test("a privacy walk that throws leaves data protection not-derivable, and keeps the cause out of the pack", async () => {
    const { text, body, logged } = await readPack(
      sources({
        privacyInventory: () => {
          throw new Error("schema walk refused: secret-table-name");
        },
      }),
    );
    expect(control(body, "data-protection").state).toBe("not-derivable");
    expect(text).not.toContain("secret-table-name");
    expect(JSON.stringify(logged)).toContain("secret-table-name");
  });

  test("a composed recorder whose binding is absent from the Worker is a gap naming the binding", async () => {
    const { body } = await readPack(sources({ composition: () => [recorder({ trail: "TRAIL" })] }), {
      emit: recording,
    });
    const logging = control(body, "audit-logging");
    expect(logging.state).toBe("gap");
    expect(logging.facts).toContainEqual({
      fact: "bindingPresent",
      subject: "TRAIL",
      value: false,
      source: "bindings",
    });
    expect(logging.reasons.join(" ")).toContain("`TRAIL`");
  });

  test("a recorder present on its binding and on the request's emit seam is evidenced", async () => {
    const { body } = await readPack(sources({ composition: () => [recorder({ trail: "TRAIL" })] }), {
      emit: recording,
      bindings: { TRAIL: env.DB },
    });
    const logging = control(body, "audit-logging");
    expect(logging.state).toBe("evidenced");
    expect(logging.facts).toEqual([
      { fact: "auditRecorder", value: "audit", source: "composition" },
      { fact: "bindingPresent", subject: "TRAIL", value: true, source: "bindings" },
      { fact: "controlPlaneCallsRecorded", value: true, source: "auditRecorder" },
    ]);
  });

  test("a recorder whose request seam is the no-op says control-plane calls go unrecorded", async () => {
    const { body } = await readPack(sources({ composition: () => [recorder({ trail: "TRAIL" })] }), {
      bindings: { TRAIL: env.DB },
    });
    const logging = control(body, "audit-logging");
    expect(logging.state).toBe("gap");
    expect(logging.facts).toContainEqual({ fact: "controlPlaneCallsRecorded", value: false, source: "auditRecorder" });
  });

  test("two of a recorder's databases on one binding are one binding fact", async () => {
    const { body } = await readPack(
      sources({ composition: () => [recorder({ trail: "TRAIL", archive: "TRAIL", rollups: "ROLLUPS" })] }),
      { emit: recording, bindings: { TRAIL: env.DB } },
    );
    const bindings = control(body, "audit-logging").facts.filter((fact) => fact.fact === "bindingPresent");
    expect(bindings).toEqual([
      { fact: "bindingPresent", subject: "TRAIL", value: true, source: "bindings" },
      { fact: "bindingPresent", subject: "ROLLUPS", value: false, source: "bindings" },
    ]);
  });

  test("with secrets not composed, its rotation is not-derivable and names the package", async () => {
    const { body } = await readPack(sources());
    const rotation = control(body, "key-rotation");
    expect(rotation.state).toBe("not-derivable");
    expect(rotation.reasons.join(" ")).toContain("@pithy-sh/secrets");
  });

  test("with secrets composed and its scope withheld, rotation is not-derivable and names the scope", async () => {
    const { body } = await readPack(sources(withSecrets()));
    const rotation = control(body, "key-rotation");
    expect(rotation.state).toBe("not-derivable");
    expect(rotation.reasons.join(" ")).toContain(SECRETS_STATUS_SCOPE);
    expect(rotation.reasons.join(" ")).not.toContain("@pithy-sh/secrets");
  });

  test("with secrets composed and its scope granted, its rotation count is read off its health", async () => {
    const { body } = await readPack(sources(withSecrets()), {
      context: { ...CONTEXT, grantedScopes: [EVIDENCE_READ_SCOPE, SECRETS_STATUS_SCOPE] },
    });
    const rotation = control(body, "key-rotation");
    expect(rotation.facts).toContainEqual({
      fact: "secretsDueForRotation",
      subject: "secrets",
      value: 1,
      source: "capabilityHealth",
    });
    expect(rotation.state).toBe("gap");
  });

  test("management access lists this environment's connections only", async () => {
    const HERE = "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b";
    const ELSEWHERE = "d8c3b2a1-5f6e-4172-8b9c-2d3e4f5a6b7c";
    await register(HERE, ENVIRONMENT, "ada@example.com");
    await register(ELSEWHERE, "staging", "eve@example.com");
    const { text, body } = await readPack(sources());
    const access = control(body, "management-access");
    expect(access.facts.some((fact) => fact.subject === HERE)).toBe(true);
    expect(text).not.toContain(ELSEWHERE);
    expect(text).not.toContain("eve@example.com");
  });
});
