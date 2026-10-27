// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { RouteSpec } from "../../http/routeSpec";
import type { PrivacyInventory } from "../../privacy/report";
import { HealthSummaryKey } from "../discovery/healthSummary";
import type { MigrationDatabaseView } from "../http/responses";
import {
  type ConnectionRecord,
  deriveAuditLogging,
  deriveChangeHistory,
  deriveCsrf,
  deriveDataProtection,
  deriveKeyRotation,
  deriveManagementAccess,
  deriveRouteVerification,
  evidenceEntry,
  settle,
} from "./derive";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

function spec(verification: RouteSpec["verification"]): RouteSpec {
  return { summary: "A route.", verification, responses: {} };
}

function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "c1",
    authorizedBy: "ada@example.com",
    actorKind: "agent",
    purpose: "Support triage.",
    scopes: ["manifest:read", "evidence:read"],
    keys: [{ validFrom: new Date(NOW.getTime() - 40 * DAY), validUntil: null, revokedAt: null }],
    ...overrides,
  };
}

const CLEAN_RETIREMENT = { blocked: false, reasons: [], liveVersions: 2 };

const SECRETS_KEYS = [
  HealthSummaryKey.parse({
    key: "secretsDueForRotation",
    kind: "count",
    states: null,
    scope: "secrets:status:read",
    cost: "indexed",
    summary: "Secrets past their cadence.",
    nominal: { atMost: 0 },
  }),
  HealthSummaryKey.parse({
    key: "lastAtRestRotation",
    kind: "state",
    states: ["succeeded", "failed", "neverRun"],
    scope: "secrets:status:read",
    cost: "indexed",
    summary: "How the last at-rest rotation ended.",
    nominal: ["succeeded"],
  }),
];

function inventory(overrides: Partial<PrivacyInventory> = {}): PrivacyInventory {
  return {
    sources: ["d1", "kv"],
    schemasWalked: 4,
    schemas: [],
    counts: { pii: 2, phi: 1 },
    observed: ["pii", "phi"],
    encryptedFields: 1,
    unrotatable: 0,
    ...overrides,
  };
}

const ATTESTED = {
  classes: ["pii", "phi"],
  consoleGate: "enforced" as const,
  reason: null,
  attestedAt: "2026-10-20T12:00:00.000Z",
};

describe("settle", () => {
  test("no gap and nothing unknown is evidenced", () => {
    expect(settle([], [], []).state).toBe("evidenced");
  });

  test("a gap outranks an unknown, and both are reported, gaps first", () => {
    expect(settle(["missing"], ["cannot say"], [])).toEqual({
      state: "gap",
      reasons: ["missing", "cannot say"],
      facts: [],
    });
  });

  test("an unknown alone is not-derivable, never evidenced", () => {
    expect(settle([], ["cannot say"], []).state).toBe("not-derivable");
  });
});

describe("evidenceEntry", () => {
  test("carries the mapping table's references beside what was derived", () => {
    expect(evidenceEntry("csrf", settle([], [], []))).toEqual({
      control: "csrf",
      title: "CSRF wherever cookie mode is",
      soc2: ["CC6.6"],
      iso27001: ["A.8.26"],
      state: "evidenced",
      reasons: [],
      facts: [],
    });
  });
});

describe("deriveAuditLogging", () => {
  test("a Worker without audit composed reports a gap naming the capability", () => {
    const derived = deriveAuditLogging({ recorder: null, emitting: false });
    expect(derived.state).toBe("gap");
    expect(derived.reasons.join(" ")).toContain("@pithy-sh/audit");
    expect(derived.facts).toContainEqual({ fact: "auditRecorder", value: null, source: "composition" });
  });

  test("a recorder whose binding is missing is a gap naming the binding", () => {
    const derived = deriveAuditLogging({
      recorder: { capability: "audit", bindings: [{ binding: "DB", present: false }] },
      emitting: true,
    });
    expect(derived.state).toBe("gap");
    expect(derived.reasons.join(" ")).toContain("`DB`");
  });

  test("a recorder that is composed, bound and on this request's emit seam is evidenced", () => {
    const derived = deriveAuditLogging({
      recorder: { capability: "audit", bindings: [{ binding: "DB", present: true }] },
      emitting: true,
    });
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toEqual([
      { fact: "auditRecorder", value: "audit", source: "composition" },
      { fact: "bindingPresent", subject: "DB", value: true, source: "bindings" },
      { fact: "controlPlaneCallsRecorded", value: true, source: "auditRecorder" },
    ]);
  });

  test("a composed recorder this request does not emit through is a gap", () => {
    const derived = deriveAuditLogging({
      recorder: { capability: "audit", bindings: [{ binding: "DB", present: true }] },
      emitting: false,
    });
    expect(derived.state).toBe("gap");
  });
});

describe("deriveRouteVerification", () => {
  test("a route table nobody assembled cannot be read, and says so", () => {
    expect(deriveRouteVerification(undefined).state).toBe("not-derivable");
  });

  test("counts each strategy once per route, a list counted under every strategy it names", () => {
    const derived = deriveRouteVerification([
      { method: "GET", path: "/a", spec: spec(["bearer", "session"]) },
      { method: "POST", path: "/b", spec: spec("public") },
      { method: "GET", path: "/c", spec: spec("control-plane") },
    ]);
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toEqual([
      { fact: "routes", value: 3, source: "routeSpec" },
      { fact: "undescribedRoutes", value: 0, source: "routeSpec" },
      { fact: "routesVerifiedBy", subject: "bearer", value: 1, source: "routeSpec" },
      { fact: "routesVerifiedBy", subject: "session", value: 1, source: "routeSpec" },
      { fact: "routesVerifiedBy", subject: "public", value: 1, source: "routeSpec" },
      { fact: "routesVerifiedBy", subject: "control-plane", value: 1, source: "routeSpec" },
    ]);
  });

  test("a route with no describeRoute is a gap naming it", () => {
    const derived = deriveRouteVerification([
      { method: "GET", path: "/a", spec: spec("public") },
      { method: "POST", path: "/mine", spec: undefined },
    ]);
    expect(derived.state).toBe("gap");
    expect(derived.reasons).toEqual(["`POST /mine` declares no verification."]);
  });

  test("names at most ten undescribed routes, and counts the rest", () => {
    const operations = Array.from({ length: 12 }, (_, index) => ({
      method: "GET",
      path: `/r${index}`,
      spec: undefined,
    }));
    const derived = deriveRouteVerification(operations);
    expect(derived.reasons).toHaveLength(11);
    expect(derived.reasons.at(-1)).toBe("2 more routes declare no verification.");
  });
});

describe("deriveManagementAccess", () => {
  test("an unreadable connections table is not-derivable, never evidenced", () => {
    const derived = deriveManagementAccess(null);
    expect(derived.state).toBe("not-derivable");
    expect(derived.reasons[0]).toMatch(/could not be read/);
  });

  test("every connection's principal, kind, purpose and grant, attributed: evidenced", () => {
    const derived = deriveManagementAccess([connection()]);
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toEqual([
      { fact: "connections", value: 1, source: "connection" },
      { fact: "authorizedBy", subject: "c1", value: "ada@example.com", source: "connection" },
      { fact: "actorKind", subject: "c1", value: "agent", source: "connection" },
      { fact: "purpose", subject: "c1", value: "Support triage.", source: "connection" },
      { fact: "scopes", subject: "c1", value: ["manifest:read", "evidence:read"], source: "connection" },
    ]);
  });

  test("a connection registered before principals were recorded is a gap naming it", () => {
    const derived = deriveManagementAccess([
      connection(),
      connection({ id: "c2", authorizedBy: null, actorKind: null, purpose: null }),
    ]);
    expect(derived.state).toBe("gap");
    expect(derived.reasons).toHaveLength(1);
    expect(derived.reasons[0]).toContain("c2");
    expect(derived.reasons[0]).toContain("principal, actor kind, purpose");
  });
});

describe("deriveKeyRotation", () => {
  const healthy = {
    state: "composed" as const,
    keys: SECRETS_KEYS,
    report: { state: "reported" as const, values: { secretsDueForRotation: 0, lastAtRestRotation: "succeeded" } },
  };

  test("key ages, secrets' cadence and a clean retirement guard: evidenced", () => {
    const derived = deriveKeyRotation({
      connections: [connection()],
      now: NOW,
      secrets: healthy,
      retirement: CLEAN_RETIREMENT,
    });
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toEqual([
      { fact: "liveKeys", subject: "c1", value: 1, source: "connectionKeys" },
      { fact: "oldestLiveKeyAgeDays", subject: "c1", value: 40, source: "connectionKeys" },
      { fact: "secretsDueForRotation", subject: "secrets", value: 0, source: "capabilityHealth" },
      { fact: "lastAtRestRotation", subject: "secrets", value: "nominal", source: "capabilityHealth" },
      { fact: "fieldKeyRetirementBlocked", value: false, source: "fieldKeyRetirement" },
      { fact: "fieldKeyRetirementReasons", value: [], source: "fieldKeyRetirement" },
      { fact: "liveFieldKeyVersions", value: 2, source: "fieldKeyRetirement" },
    ]);
  });

  test("a revoked, expired or future key is not live, and a connection with none reports no age", () => {
    const derived = deriveKeyRotation({
      connections: [
        connection({
          keys: [
            { validFrom: new Date(NOW.getTime() - 9 * DAY), validUntil: null, revokedAt: NOW },
            {
              validFrom: new Date(NOW.getTime() - 9 * DAY),
              validUntil: new Date(NOW.getTime() - DAY),
              revokedAt: null,
            },
            { validFrom: new Date(NOW.getTime() + DAY), validUntil: null, revokedAt: null },
          ],
        }),
      ],
      now: NOW,
      secrets: healthy,
      retirement: CLEAN_RETIREMENT,
    });
    expect(derived.facts.filter((fact) => fact.source === "connectionKeys")).toEqual([
      { fact: "liveKeys", subject: "c1", value: 0, source: "connectionKeys" },
      { fact: "oldestLiveKeyAgeDays", subject: "c1", value: null, source: "connectionKeys" },
    ]);
  });

  test("secrets past their cadence is a gap naming the key", () => {
    const derived = deriveKeyRotation({
      connections: [connection()],
      now: NOW,
      secrets: {
        ...healthy,
        report: { state: "reported", values: { secretsDueForRotation: 3, lastAtRestRotation: "succeeded" } },
      },
      retirement: CLEAN_RETIREMENT,
    });
    expect(derived.state).toBe("gap");
    expect(derived.reasons.join(" ")).toContain("secretsDueForRotation");
  });

  test("a state wanting attention is reported by its standing, never by the word the capability uses", () => {
    const derived = deriveKeyRotation({
      connections: [connection()],
      now: NOW,
      secrets: {
        ...healthy,
        report: { state: "reported", values: { secretsDueForRotation: 0, lastAtRestRotation: "failed" } },
      },
      retirement: CLEAN_RETIREMENT,
    });
    expect(derived.state).toBe("gap");
    expect(JSON.stringify(derived)).not.toMatch(/failed/);
    expect(derived.facts).toContainEqual({
      fact: "lastAtRestRotation",
      subject: "secrets",
      value: "attention",
      source: "capabilityHealth",
    });
  });

  test("secrets' status withheld from this connection is not-derivable, naming the scope", () => {
    const derived = deriveKeyRotation({
      connections: [connection()],
      now: NOW,
      secrets: { ...healthy, report: { state: "withheld" } },
      retirement: CLEAN_RETIREMENT,
    });
    expect(derived.state).toBe("not-derivable");
    expect(derived.reasons.join(" ")).toContain("secrets:status:read");
  });

  test("secrets unable to report, an older secrets, and no secrets at all are each not-derivable", () => {
    for (const secrets of [
      { ...healthy, report: { state: "unavailable" as const } },
      { ...healthy, report: { state: "undeclared" as const } },
      { state: "not-composed" as const },
    ]) {
      const derived = deriveKeyRotation({
        connections: [connection()],
        now: NOW,
        secrets,
        retirement: CLEAN_RETIREMENT,
      });
      expect(derived.state, JSON.stringify(secrets)).toBe("not-derivable");
    }
  });

  test("a held field-key retirement is a gap naming why", () => {
    const derived = deriveKeyRotation({
      connections: [connection()],
      now: NOW,
      secrets: healthy,
      retirement: { blocked: true, reasons: ["stale"], liveVersions: 3 },
    });
    expect(derived.state).toBe("gap");
    expect(derived.reasons.join(" ")).toContain("stale");
  });

  test("a retirement guard that could not read every source is not-derivable, never evidenced", () => {
    // `readRetirement` reports `blocked: false` when it could not resolve the key set or derive the columns: nothing
    // is due because nothing was read. That is an unknown, not a clean guard.
    const derived = deriveKeyRotation({
      connections: [connection()],
      now: NOW,
      secrets: healthy,
      retirement: { blocked: false, reasons: ["incomplete-coverage"], liveVersions: 0 },
    });
    expect(derived.state).toBe("not-derivable");
    expect(derived.reasons).toEqual(["The field key's retirement guard could not read every source on this call."]);
    expect(derived.facts).toContainEqual({
      fact: "fieldKeyRetirementReasons",
      value: ["incomplete-coverage"],
      source: "fieldKeyRetirement",
    });
  });

  test("a guard not clean with nothing due is reported as a fact, and is not itself an unknown", () => {
    const derived = deriveKeyRotation({
      connections: [connection()],
      now: NOW,
      secrets: healthy,
      retirement: { blocked: false, reasons: ["unrotatable"], liveVersions: 2 },
    });
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toContainEqual({
      fact: "fieldKeyRetirementReasons",
      value: ["unrotatable"],
      source: "fieldKeyRetirement",
    });
  });

  test("an unreadable connections table is not-derivable", () => {
    const derived = deriveKeyRotation({ connections: null, now: NOW, secrets: healthy, retirement: CLEAN_RETIREMENT });
    expect(derived.state).toBe("not-derivable");
  });
});

describe("deriveChangeHistory", () => {
  const readable: MigrationDatabaseView = {
    state: "readable",
    database: "app",
    binding: "DB",
    applied: [{ name: "1100_controlplane_0001_init", namespace: "controlplane" }],
    pending: [],
    undeclared: [],
    lastGroup: {
      group: "release-7",
      appliedAt: "2026-10-01T00:00:00.000Z",
      migrations: [{ name: "1100_controlplane_0001_init", namespace: "controlplane" }],
      position: { state: "top" },
    },
  };

  test("withheld migrations:read is not-derivable naming the scope, and reads nothing", () => {
    const derived = deriveChangeHistory({ granted: false, databases: [] });
    expect(derived.state).toBe("not-derivable");
    expect(derived.reasons.join(" ")).toContain("migrations:read");
    expect(derived.facts).toEqual([]);
  });

  test("every database's applied history, its last group and when: evidenced", () => {
    const derived = deriveChangeHistory({ granted: true, databases: [readable] });
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toEqual([
      { fact: "applied", subject: "app", value: 1, source: "migrationLedger" },
      { fact: "pending", subject: "app", value: 0, source: "migrationLedger" },
      { fact: "undeclared", subject: "app", value: 0, source: "migrationLedger" },
      { fact: "lastGroup", subject: "app", value: "release-7", source: "migrationLedger" },
      { fact: "lastGroupAppliedAt", subject: "app", value: "2026-10-01T00:00:00.000Z", source: "migrationLedger" },
    ]);
  });

  test("a pending migration is a gap naming the database", () => {
    const derived = deriveChangeHistory({
      granted: true,
      databases: [{ ...readable, pending: [{ name: "1100_controlplane_0004_x", namespace: "controlplane" }] }],
    });
    expect(derived.state).toBe("gap");
    expect(derived.reasons[0]).toContain("`app`");
  });

  test("an unreadable ledger is not-derivable, never evidenced", () => {
    const derived = deriveChangeHistory({
      granted: true,
      databases: [{ state: "unreadable", database: "app", binding: "DB" }],
    });
    expect(derived.state).toBe("not-derivable");
  });
});

describe("deriveDataProtection", () => {
  test("classes held, declared and encrypted counts, nothing undeclared: evidenced", () => {
    const derived = deriveDataProtection({ inventory: inventory(), attestation: ATTESTED });
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toEqual([
      { fact: "classesHeld", value: ["pii", "phi"], source: "privacyMarkers" },
      { fact: "markedFields", subject: "pii", value: 2, source: "privacyMarkers" },
      { fact: "markedFields", subject: "phi", value: 1, source: "privacyMarkers" },
      { fact: "schemasWalked", value: 4, source: "privacyMarkers" },
      { fact: "encryptedFields", value: 1, source: "encryptedMarkers" },
      { fact: "unrotatableEncryptedFields", value: 0, source: "encryptedMarkers" },
      { fact: "classesDeclared", value: ["pii", "phi"], source: "privacyAttestation" },
    ]);
  });

  test("a class held and never declared is a gap naming it", () => {
    const derived = deriveDataProtection({ inventory: inventory(), attestation: { ...ATTESTED, classes: ["pii"] } });
    expect(derived.state).toBe("gap");
    expect(derived.reasons.join(" ")).toContain("`phi`");
  });

  test("a class declared with nothing behind it is a gap naming it", () => {
    const derived = deriveDataProtection({
      inventory: inventory(),
      attestation: { ...ATTESTED, classes: ["pii", "phi", "pci"] },
    });
    expect(derived.state).toBe("gap");
    expect(derived.reasons.join(" ")).toContain("`pci`");
  });

  test("no attestation is not-derivable: what was declared cannot be read", () => {
    const derived = deriveDataProtection({ inventory: inventory(), attestation: null });
    expect(derived.state).toBe("not-derivable");
    expect(derived.facts).toContainEqual({ fact: "classesDeclared", value: null, source: "privacyAttestation" });
  });

  test("an inventory that could not be walked is not-derivable", () => {
    expect(deriveDataProtection({ inventory: null, attestation: ATTESTED }).state).toBe("not-derivable");
  });
});

describe("deriveCsrf", () => {
  const sessionRoute = { method: "POST", path: "/x", spec: spec(["bearer", "session"]) };

  test("cookie routes with a same-origin policy published: evidenced", () => {
    const derived = deriveCsrf({ operations: [sessionRoute], sameOriginPublished: true });
    expect(derived.state).toBe("evidenced");
    expect(derived.facts).toEqual([
      { fact: "sessionRoutes", value: 1, source: "routeSpec" },
      { fact: "sameOriginPolicy", value: true, source: "sameOriginGate" },
    ]);
  });

  test("cookie routes and no same-origin policy is a gap", () => {
    expect(deriveCsrf({ operations: [sessionRoute], sameOriginPublished: false }).state).toBe("gap");
  });

  test("no route takes a cookie: nothing needs a same-origin policy, evidenced", () => {
    const derived = deriveCsrf({
      operations: [{ method: "GET", path: "/y", spec: spec("bearer") }],
      sameOriginPublished: false,
    });
    expect(derived.state).toBe("evidenced");
  });

  test("a route table nobody assembled is not-derivable", () => {
    expect(deriveCsrf({ operations: undefined, sameOriginPublished: true }).state).toBe("not-derivable");
  });
});
