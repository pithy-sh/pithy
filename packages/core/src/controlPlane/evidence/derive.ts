// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DescribedOperation } from "../../openapi/operations";
import type { PrivacyAttestation } from "../../privacy/posture";
import type { PrivacyInventory } from "../../privacy/report";
import type { RetirementVerdict } from "../../privacy/retirement";
import type { ControlPlaneConnection, RegisteredKey } from "../data/connection";
import { type CapabilityHealthReport, type HealthSummaryKey, standingOf } from "../discovery/healthSummary";
import type { EvidenceEntry, EvidenceFact, MigrationDatabaseView } from "../http/responses";
import { MIGRATIONS_READ_SCOPE } from "../scope/scope";
import {
  AUDIT_PACKAGE,
  EVIDENCE_CONTROLS,
  type EvidenceControlId,
  type EvidenceState,
  SECRETS_CAPABILITY,
  SECRETS_PACKAGE,
} from "./mapping";

/**
 * The derivation behind each control in the evidence pack (#821): plain inputs in, facts and a state out.
 *
 * **Every function here is pure.** The reads — a D1 query, a health producer, the route table — happen in
 * `./pack.ts`, which hands each one what it found or the fact that it could not look. So every rule for a state
 * is tested here directly, without a Worker, and the rules cannot drift by being restated at a read site.
 *
 * **What decides a state.** A gap is something positively missing. Not-derivable is the Worker being unable to
 * say. Evidenced is neither. A control with both reports `gap`, and lists the gaps first and the unknowns after,
 * because something known to be missing is the more actionable fact and the unknowns are still there to read.
 * Nothing here says more than the facts do: an unknown is never folded into `evidenced`.
 */

/** What a control's derivation produced, before the mapping table's references are attached. */
export interface Derived {
  state: EvidenceState;
  reasons: string[];
  facts: EvidenceFact[];
}

/** Settle a control's state from what was missing and what could not be read. See the module doc. */
export function settle(gaps: readonly string[], unknowns: readonly string[], facts: EvidenceFact[]): Derived {
  const state: EvidenceState = gaps.length > 0 ? "gap" : unknowns.length > 0 ? "not-derivable" : "evidenced";
  return { state, reasons: [...gaps, ...unknowns], facts };
}

/** One entry of the pack: the mapping table's row for the control, beside what was derived. */
export function evidenceEntry(control: EvidenceControlId, derived: Derived): EvidenceEntry {
  const row = EVIDENCE_CONTROLS[control];
  return {
    control,
    title: row.title,
    soc2: [...row.soc2],
    iso27001: [...row.iso27001],
    state: derived.state,
    reasons: derived.reasons,
    facts: derived.facts,
  };
}

/** How many undescribed routes a reason names before it counts the rest. */
const NAMED_ROUTE_LIMIT = 10;

/** What the audit-logging control reads. */
export interface AuditLoggingInput {
  /** The composed capability declaring an audit recorder, with each binding it writes through, or null for none. */
  recorder: { capability: string; bindings: readonly { binding: string; present: boolean }[] } | null;
  /** Whether this very request's emit seam is a recorder rather than the no-op: the guard wrote through it. */
  emitting: boolean;
}

/**
 * Audit logging in force: a composed recorder, the binding it writes through, and this request's emit seam
 * actually recording. The seam's guard emits on every control-plane call, allowed or denied, so a recorder on
 * the seam is a record of every management call — including the one reading this pack.
 */
export function deriveAuditLogging(input: AuditLoggingInput): Derived {
  const facts: EvidenceFact[] = [
    { fact: "auditRecorder", value: input.recorder?.capability ?? null, source: "composition" },
  ];
  const gaps: string[] = [];
  if (!input.recorder) {
    gaps.push(
      `No composed capability records audit events, so control-plane calls and every other audited action go unrecorded. Compose ${AUDIT_PACKAGE}.`,
    );
    return settle(gaps, [], facts);
  }
  for (const { binding, present } of input.recorder.bindings) {
    facts.push({ fact: "bindingPresent", subject: binding, value: present, source: "bindings" });
    if (!present) {
      gaps.push(
        `The \`${binding}\` binding \`${input.recorder.capability}\` records through is missing from this Worker, so its events are dropped.`,
      );
    }
  }
  facts.push({ fact: "controlPlaneCallsRecorded", value: input.emitting, source: "auditRecorder" });
  if (!input.emitting) {
    gaps.push(
      `This request's emit seam is not \`${input.recorder.capability}\`'s recorder, so control-plane calls go unrecorded.`,
    );
  }
  return settle(gaps, [], facts);
}

/** The strategies a spec names, as a list. */
function strategiesOf(operation: DescribedOperation): readonly string[] {
  const verification = operation.spec?.verification;
  if (verification === undefined) return [];
  return typeof verification === "string" ? [verification] : verification;
}

/** Why a control reading the route table cannot: an app `createBackend` did not assemble has no recorded groups. */
const NO_ROUTE_TABLE = "This Worker's route table was not assembled by `createBackend`, so it cannot be read.";

/**
 * Every route declares how a caller is verified: `describeRoute`'s `verification`, read off the composed route
 * table. A route with no `describeRoute` declares nothing, and is named.
 */
export function deriveRouteVerification(operations: readonly DescribedOperation[] | undefined): Derived {
  if (operations === undefined) return settle([], [NO_ROUTE_TABLE], []);
  const undescribed = operations.filter((operation) => operation.spec === undefined);
  const counts = new Map<string, number>();
  for (const operation of operations) {
    for (const strategy of strategiesOf(operation)) counts.set(strategy, (counts.get(strategy) ?? 0) + 1);
  }
  const facts: EvidenceFact[] = [
    { fact: "routes", value: operations.length, source: "routeSpec" },
    { fact: "undescribedRoutes", value: undescribed.length, source: "routeSpec" },
    ...[...counts].map(
      ([strategy, count]): EvidenceFact => ({
        fact: "routesVerifiedBy",
        subject: strategy,
        value: count,
        source: "routeSpec",
      }),
    ),
  ];
  const gaps = undescribed
    .slice(0, NAMED_ROUTE_LIMIT)
    .map((operation) => `\`${operation.method} ${operation.path}\` declares no verification.`);
  const rest = undescribed.length - NAMED_ROUTE_LIMIT;
  if (rest > 0) gaps.push(`${rest} more ${rest === 1 ? "route declares" : "routes declare"} no verification.`);
  return settle(gaps, [], facts);
}

/** What the management-access and key-rotation controls read off one connection row. Never key material. */
export type ConnectionRecord = Pick<
  ControlPlaneConnection,
  "id" | "authorizedBy" | "actorKind" | "purpose" | "scopes"
> & {
  keys: readonly Pick<RegisteredKey, "validFrom" | "validUntil" | "revokedAt">[];
};

/** Why a control reading the connections table cannot. */
const CONNECTIONS_UNREADABLE = "The control-plane connections table could not be read on this call.";

/**
 * Management access attributed and scoped: every connection in this environment, with the principal who
 * authorized it, its actor kind, its purpose (#721) and its granted scopes. The principal is the email the
 * connection records and nothing else; no audit row's actor is copied in.
 */
export function deriveManagementAccess(connections: readonly ConnectionRecord[] | null): Derived {
  if (connections === null) return settle([], [CONNECTIONS_UNREADABLE], []);
  const facts: EvidenceFact[] = [{ fact: "connections", value: connections.length, source: "connection" }];
  const gaps: string[] = [];
  for (const connection of connections) {
    facts.push(
      { fact: "authorizedBy", subject: connection.id, value: connection.authorizedBy, source: "connection" },
      { fact: "actorKind", subject: connection.id, value: connection.actorKind, source: "connection" },
      { fact: "purpose", subject: connection.id, value: connection.purpose, source: "connection" },
      { fact: "scopes", subject: connection.id, value: [...connection.scopes], source: "connection" },
    );
    const missing = [
      connection.authorizedBy === null ? "principal" : null,
      connection.actorKind === null ? "actor kind" : null,
      connection.purpose === null ? "purpose" : null,
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      gaps.push(
        `Connection ${connection.id} records no ${missing.join(", ")}: it was registered before they were recorded. Registering it again records them.`,
      );
    }
  }
  return settle(gaps, [], facts);
}

/** A day, in ms. Key ages are reported in whole days, which is how a rotation cadence is reasoned about. */
const MS_PER_DAY = 86_400_000;

/** Whether a key verifies right now: started, not past its window, not revoked. */
function isLive(key: ConnectionRecord["keys"][number], now: Date): boolean {
  if (key.revokedAt !== null) return false;
  if (key.validFrom.getTime() > now.getTime()) return false;
  return key.validUntil === null || key.validUntil.getTime() > now.getTime();
}

/** What secrets' rotation status was on this call: its health report and the keys that declare it, or absent. */
export type SecretsRotationInput =
  | { state: "not-composed" }
  | { state: "composed"; keys: readonly HealthSummaryKey[]; report: CapabilityHealthReport };

/** What the key-rotation control reads. */
export interface KeyRotationInput {
  connections: readonly ConnectionRecord[] | null;
  now: Date;
  secrets: SecretsRotationInput;
  retirement: RetirementVerdict;
}

/** Secrets' facts, gaps and unknowns from its declared health — by standing for a state, never by its word. */
function secretsRotation(input: SecretsRotationInput, facts: EvidenceFact[], gaps: string[], unknowns: string[]): void {
  if (input.state === "not-composed") {
    unknowns.push(`${SECRETS_PACKAGE} is not composed, so no secret's rotation cadence is declared here.`);
    return;
  }
  const report = input.report;
  if (report.state === "withheld") {
    const scopes = [...new Set(input.keys.map((key) => `\`${key.scope}\``))].join(", ");
    unknowns.push(
      `This connection is not granted ${scopes}, the scope \`${SECRETS_CAPABILITY}\` reports rotation status under.`,
    );
    return;
  }
  if (report.state === "unavailable") {
    unknowns.push(`\`${SECRETS_CAPABILITY}\` could not report its rotation status on this call.`);
    return;
  }
  if (report.state === "undeclared") {
    unknowns.push(`\`${SECRETS_CAPABILITY}\` reports no rotation status: it predates the health summary.`);
    return;
  }
  for (const key of input.keys) {
    const value = report.values[key.key];
    if (value === undefined) continue;
    const standing = standingOf(key, value);
    // A count is a number and says what it is. A state is reported by its standing, so the capability's own word
    // for an outcome never becomes the pack's: the pack carries evidence, and leaves the outcome to its route.
    facts.push({
      fact: key.key,
      subject: SECRETS_CAPABILITY,
      value: key.kind === "count" ? value : standing,
      source: "capabilityHealth",
    });
    if (standing === "attention") {
      gaps.push(
        `\`${SECRETS_CAPABILITY}\` reports \`${key.key}\` wanting attention. Its status route says which and why.`,
      );
    }
  }
}

/**
 * Keys and secrets rotate: each connection's live keys and the age of the oldest, secrets' declared cadence and
 * what is past it, and the field key's retirement guard (#390). Ages are facts and never graded here: the seam
 * declares no cadence for control-plane keys, and inventing one would be the pack's opinion.
 */
export function deriveKeyRotation(input: KeyRotationInput): Derived {
  const facts: EvidenceFact[] = [];
  const gaps: string[] = [];
  const unknowns: string[] = [];
  if (input.connections === null) {
    unknowns.push(`${CONNECTIONS_UNREADABLE} Key ages are unknown.`);
  } else {
    for (const connection of input.connections) {
      const live = connection.keys.filter((key) => isLive(key, input.now));
      const oldest = live.reduce<number | null>(
        (min, key) => (min === null ? key.validFrom.getTime() : Math.min(min, key.validFrom.getTime())),
        null,
      );
      facts.push(
        { fact: "liveKeys", subject: connection.id, value: live.length, source: "connectionKeys" },
        {
          fact: "oldestLiveKeyAgeDays",
          subject: connection.id,
          value: oldest === null ? null : Math.floor((input.now.getTime() - oldest) / MS_PER_DAY),
          source: "connectionKeys",
        },
      );
    }
  }
  secretsRotation(input.secrets, facts, gaps, unknowns);
  facts.push(
    { fact: "fieldKeyRetirementBlocked", value: input.retirement.blocked, source: "fieldKeyRetirement" },
    { fact: "fieldKeyRetirementReasons", value: [...input.retirement.reasons], source: "fieldKeyRetirement" },
    { fact: "liveFieldKeyVersions", value: input.retirement.liveVersions, source: "fieldKeyRetirement" },
  );
  if (input.retirement.blocked) {
    gaps.push(`The field key's oldest live version is held from retirement: ${input.retirement.reasons.join(", ")}.`);
  } else if (input.retirement.reasons.includes("incomplete-coverage")) {
    // The guard reports `blocked: false` when it could not resolve the key set or derive the columns: nothing is
    // due because nothing was read. That is the Worker unable to say, never a clean guard.
    unknowns.push("The field key's retirement guard could not read every source on this call.");
  }
  return settle(gaps, unknowns, facts);
}

/** What the change-history control reads. */
export interface ChangeHistoryInput {
  /** Whether this connection holds `migrations:read`, the scope the seam keeps migration state behind. */
  granted: boolean;
  /** Each bound database's ledger, read only when granted. */
  databases: readonly MigrationDatabaseView[];
}

/**
 * Change history per environment: each bound database's applied migrations, the last group and when it applied
 * (#729). Behind `migrations:read`, as the same numbers are on the manifest, so the pack never widens it.
 */
export function deriveChangeHistory(input: ChangeHistoryInput): Derived {
  if (!input.granted) {
    return settle(
      [],
      [`This connection is not granted \`${MIGRATIONS_READ_SCOPE}\`, the scope migration state is read under.`],
      [],
    );
  }
  const facts: EvidenceFact[] = [];
  const gaps: string[] = [];
  const unknowns: string[] = [];
  for (const database of input.databases) {
    if (database.state === "unreadable") {
      unknowns.push(`The migration ledger of database \`${database.database}\` could not be read on this call.`);
      continue;
    }
    const subject = database.database;
    facts.push(
      { fact: "applied", subject, value: database.applied.length, source: "migrationLedger" },
      { fact: "pending", subject, value: database.pending.length, source: "migrationLedger" },
      { fact: "undeclared", subject, value: database.undeclared.length, source: "migrationLedger" },
      { fact: "lastGroup", subject, value: database.lastGroup?.group ?? null, source: "migrationLedger" },
      { fact: "lastGroupAppliedAt", subject, value: database.lastGroup?.appliedAt ?? null, source: "migrationLedger" },
    );
    if (database.pending.length > 0) {
      gaps.push(
        `Database \`${subject}\` has ${database.pending.length} declared ${database.pending.length === 1 ? "migration" : "migrations"} this build ships and has not applied.`,
      );
    }
  }
  return settle(gaps, unknowns, facts);
}

/** What the data-protection control reads. */
export interface DataProtectionInput {
  /** The privacy inventory of every stored schema, or null where the walk could not run. */
  inventory: PrivacyInventory | null;
  /** What the last `pithy deploy` attested the project declares, or null where none reached this Worker. */
  attestation: PrivacyAttestation | null;
}

/**
 * Data classified and encrypted at rest: the classes the stored schemas hold (#132) beside the classes the
 * project declared, and the fields marked `encrypted()` (#390). Classes and counts only, never a field's name:
 * those are `GET /privacy`'s, behind their own scope.
 */
export function deriveDataProtection(input: DataProtectionInput): Derived {
  if (input.inventory === null) {
    return settle([], ["This Worker's stored schemas could not be walked for privacy markers on this call."], []);
  }
  const held = input.inventory;
  const facts: EvidenceFact[] = [
    { fact: "classesHeld", value: [...held.observed], source: "privacyMarkers" },
    ...held.observed.map(
      (name): EvidenceFact => ({
        fact: "markedFields",
        subject: name,
        value: held.counts[name] ?? 0,
        source: "privacyMarkers",
      }),
    ),
    { fact: "schemasWalked", value: held.schemasWalked, source: "privacyMarkers" },
    { fact: "encryptedFields", value: held.encryptedFields, source: "encryptedMarkers" },
    { fact: "unrotatableEncryptedFields", value: held.unrotatable, source: "encryptedMarkers" },
    {
      fact: "classesDeclared",
      value: input.attestation === null ? null : [...input.attestation.classes],
      source: "privacyAttestation",
    },
  ];
  if (input.attestation === null) {
    return settle(
      [],
      [
        "No privacy attestation reached this Worker, so what the project declares cannot be read. A deploy through the CLI writes one.",
      ],
      facts,
    );
  }
  const declared = new Set(input.attestation.classes);
  const observed = new Set(held.observed);
  const gaps = [
    ...held.observed
      .filter((name) => !declared.has(name))
      .map((name) => `Stored schemas hold \`${name}\` fields the project never declared.`),
    ...input.attestation.classes
      .filter((name) => !observed.has(name))
      .map((name) => `The project declares \`${name}\` and no stored field is marked with it.`),
  ];
  return settle(gaps, [], facts);
}

/** What the CSRF control reads. */
export interface CsrfInput {
  operations: readonly DescribedOperation[] | undefined;
  /** Whether a composed capability published a same-origin policy on this request. */
  sameOriginPublished: boolean;
}

/**
 * CSRF wherever cookie mode is: the routes that accept a session cookie, and whether a composed capability
 * publishes the same-origin policy `requireSameOrigin()` enforces. No route taking a cookie needs none.
 */
export function deriveCsrf(input: CsrfInput): Derived {
  if (input.operations === undefined) return settle([], [NO_ROUTE_TABLE], []);
  const sessionRoutes = input.operations.filter((operation) => strategiesOf(operation).includes("session")).length;
  const facts: EvidenceFact[] = [
    { fact: "sessionRoutes", value: sessionRoutes, source: "routeSpec" },
    { fact: "sameOriginPolicy", value: input.sameOriginPublished, source: "sameOriginGate" },
  ];
  const gaps =
    sessionRoutes > 0 && !input.sameOriginPublished
      ? [
          `${sessionRoutes} ${sessionRoutes === 1 ? "route accepts" : "routes accept"} a session cookie and no composed capability publishes a same-origin policy. Compose \`@pithy-sh/auth\`.`,
        ]
      : [];
  return settle(gaps, [], facts);
}
