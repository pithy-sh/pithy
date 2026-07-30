// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The audit-event seam. `AuditEvent` is the shape any capability hands to `emit()` (the request
 * context's recorder) — the logical event, before storage. `@pithy-sh/audit` owns the D1 table that
 * persists it (`pithy_audit_events`, with codecs); core owns only this contract so a capability
 * emits an event without importing the audit package (principle 4). With no audit capability
 * installed, `emit()` is a no-op and these types are still the contract every emitter writes to.
 *
 * Every field carries a `.describe()` — the schema is the documentation, and it drives the
 * generated audit-event catalog the dashboard reads.
 */

/** `domain/reason` — a namespaced lowercase action code (`auth/login`, `admin/config_changed`). */
const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9]*\/[a-z][a-z0-9_]*$/;

/**
 * The action taxonomy is **federated, not centralized**: `action` is an open, namespace-validated
 * `domain/reason` string, and each capability owns and exports its own action constants (`auth/*`,
 * `entitlement/*`, `admin/*`) — added without touching core, the way migrations and table prefixes
 * already federate. Core never holds a closed union of every event.
 */
export const AuditAction = z
  .string()
  .regex(
    AUDIT_ACTION_PATTERN,
    "An audit action must be a namespaced `domain/reason` code: lowercase, the domain and reason separated by a single `/` (e.g. `auth/login`).",
  )
  .describe("A namespaced `domain/reason` action code (`auth/login`, `admin/config_changed`); the federated taxonomy.");
export type AuditAction = z.output<typeof AuditAction>;

/** The result of an audited action. A blocked authorization attempt is a first-class record. */
export const AuditOutcome = z
  .enum(["success", "failure", "denied"])
  .describe(
    "The result of the audited action: `success`, `failure` (it was attempted and errored), or `denied` (an authorization gate blocked it). `denied` is first-class — blocked attempts are recorded, not only successes.",
  );
export type AuditOutcome = z.output<typeof AuditOutcome>;

/** How serious the event is — orthogonal to outcome; drives dashboard filtering and alerting. */
export const AuditSeverity = z
  .enum(["info", "warning", "critical"])
  .describe(
    "The event's severity, orthogonal to its outcome: `info` (routine), `warning` (notable), `critical` (alert-worthy). Drives dashboard filtering and alerting.",
  );
export type AuditSeverity = z.output<typeof AuditSeverity>;

/**
 * What kind of principal acted. `anonymous` covers an unauthenticated request; `system` an internal job.
 *
 * `control-plane` is its own kind rather than a flavour of `service` because the question an adopter
 * actually asks is "what did the management client do", separately from "what did my users do". A
 * control-plane caller is not a user of their app at all — it holds no session and owns no user row —
 * so folding it into `user` or `service` would make that question unanswerable from the trail.
 */
export const AuditActorType = z
  .enum(["user", "service", "system", "anonymous", "control-plane"])
  .describe(
    "The kind of principal that acted: `user` (an authenticated person), `service` (a service account or CI token), `system` (an internal job, no external actor), `anonymous` (an unauthenticated request), or `control-plane` (a management client calling in under the `control-plane` strategy — a principal outside the adopter's own user base, whose actions are answerable separately from their users').",
  );
export type AuditActorType = z.output<typeof AuditActorType>;

/** Capability-specific structured detail attached to an event; Zod-validated on write and read. */
export const AuditMetadata = z
  .record(z.string(), z.unknown())
  .describe(
    "Capability-specific structured detail (a JSON object), validated on write and read. Never put a secret, credential, or sensitive payload here — the trail is queryable and long-lived.",
  );
export type AuditMetadata = z.output<typeof AuditMetadata>;

/**
 * One audit event as an emitter supplies it. `occurredAt` is optional — the recorder stamps it at
 * write time when absent. The nullable correlation fields (`actorId`, `sessionId`, request fields,
 * resource fields) are populated from request context where available; an emitter sets only what it
 * knows. The recorder turns this into the stored `pithy_audit_events` row.
 */
export const AuditEvent = z
  .object({
    action: AuditAction.describe("What happened, as a namespaced `domain/reason` action code."),
    outcome: AuditOutcome.describe("Whether the action succeeded, failed, or was denied."),
    severity: AuditSeverity.default("info").describe("How serious the event is; defaults to `info`."),
    actorType: AuditActorType.describe("The kind of principal that acted."),
    actorId: z
      .string()
      .nullish()
      .describe("The acting principal's stable id (user id, service/token name); null for `system`/`anonymous`."),
    sessionId: z
      .string()
      .nullish()
      .describe("The session this action belongs to, tying a chain of actions together; null when none."),
    resourceType: z
      .string()
      .nullish()
      .describe("The type of resource the action targeted (e.g. `user`, `secret`); null when not resource-scoped."),
    resourceId: z
      .string()
      .nullish()
      .describe("The id of the resource the action targeted; null when not resource-scoped."),
    ip: z.string().nullish().describe("The client IP the request came from, for correlation; null when unknown."),
    userAgent: z.string().nullish().describe("The client user-agent string, for correlation; null when unknown."),
    requestId: z
      .string()
      .nullish()
      .describe("The request correlation id, tying this event to a single request/trace; null when unknown."),
    occurredAt: z
      .date()
      .optional()
      .describe("When the action occurred. Optional on emit — the recorder stamps the current time when absent."),
    metadata: AuditMetadata.nullish().describe("Capability-specific structured detail; null when there is none."),
  })
  .describe("One audit event as an emitter supplies it to `emit()` — the logical event before storage.");
export type AuditEvent = z.output<typeof AuditEvent>;
export type AuditEventInput = z.input<typeof AuditEvent>;
