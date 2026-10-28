// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Hono } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { describeRoute } from "../../http/routeSpec";
import { validate } from "../../http/validation";
import { PresenceTicket } from "../../presence/http/responses";
import { ControlPlanePresenceTicketRequest } from "../../presence/http/schemas";
import { type AdminRoute, ControlPlaneManifest } from "../discovery/adminRoute";
import {
  ANY_VERIFIED_CALLER,
  ERASURE_READ_SCOPE,
  EVIDENCE_READ_SCOPE,
  KEYS_ROTATE_SCOPE,
  MANIFEST_READ_SCOPE,
  MIGRATIONS_READ_SCOPE,
  PRIVACY_READ_SCOPE,
  PROCESSING_READ_SCOPE,
  RETENTION_HOLD_SCOPE,
  RETENTION_READ_SCOPE,
} from "../scope/scope";
import { requireControlPlane } from "./guard";
import {
  type ControlPlaneHandlerDeps,
  erasurePeriodHandler,
  erasureSubjectHandler,
  evidenceHandler,
  expireKeyHandler,
  listKeysHandler,
  manifestHandler,
  migrationsHandler,
  pingHandler,
  privacyHandler,
  registerKeyHandler,
} from "./handlers";
import { listHoldsHandler, placeHoldHandler, releaseHoldHandler } from "./holds";
import { presenceTicketGate, presenceTicketHandler } from "./presence";
import { processingHandler } from "./processing";
import {
  ControlPlaneErasurePeriodResponse,
  ControlPlaneErasureSubjectResponse,
  ControlPlaneEvidenceResponse,
  ControlPlaneHoldResponse,
  ControlPlaneHoldsResponse,
  ControlPlaneKeysResponse,
  ControlPlaneMigrationsResponse,
  ControlPlanePingResponse,
  ControlPlanePrivacyResponse,
  ControlPlaneProcessingResponse,
  ExpireKeyResponse,
  RegisterKeyResponse,
} from "./responses";
import {
  ErasurePeriodQuery,
  ErasureSubjectParams,
  ExpireKeyParams,
  ExpireKeyRequest,
  HoldListQuery,
  HoldParams,
  PlaceHoldRequest,
  RegisterKeyRequest,
  ReleaseHoldRequest,
} from "./schemas";

/**
 * The seam's own routes, distinct from the admin routes capabilities contribute.
 *
 *   GET  /control-plane/ping                  → connectivity and key proof   (any verified caller)
 *   GET  /control-plane/manifest              → what this Worker composes    (manifest:read)
 *   GET  /control-plane/keys                  → the registration state       (keys:rotate)
 *   POST /control-plane/keys                  → register a key               (keys:rotate)
 *   POST /control-plane/keys/:keyId/expire    → retire a superseded key      (keys:rotate)
 *   GET  /control-plane/migrations            → where each database stands   (migrations:read)
 *   GET  /control-plane/privacy               → what each schema holds        (privacy:read)
 *   GET  /control-plane/evidence              → SOC 2 and ISO 27001 evidence  (evidence:read)
 *   GET  /control-plane/processing            → the Article 30 record         (processing:read)
 *   GET  /control-plane/erasure               → every purge in a period       (erasure:read)
 *   GET  /control-plane/erasure/:type/:id     → one subject's purge, attested (erasure:read)
 *   GET  /control-plane/holds                 → every legal hold              (retention:read)
 *   POST /control-plane/holds                 → place a legal hold            (retention:hold)
 *   POST /control-plane/holds/:id/release     → release one, with a reason    (retention:hold)
 *   POST /control-plane/presence/tickets      → a ticket into a presence room (the room kind's scope)
 *
 * Every one is `control-plane` and default-denied — with no connection registered they all answer 403,
 * and that is the shipped state of a Worker nobody has connected.
 *
 * **Guards precede validators on every line.** A validator first would turn a 401 into a 400 and tell a
 * caller with no credential which request shapes were well-formed. On these routes that is a live
 * oracle over key registration, which is the last thing that should be probeable.
 *
 * The three key routes share one scope. Reading which keys are live, registering the next one, and
 * retiring the last are one lifecycle, and an adopter deciding whether a management client may touch
 * their keys is making one decision, not three.
 *
 * The table is declared twice on purpose — once as descriptors a client can read, once as the
 * registrations themselves — and `routeContract.test.ts` proves the two agree.
 */

/**
 * The seam's own routes, described for `GET /control-plane/manifest`.
 *
 * Derived from the same `basePath` the routes below mount on, so the two cannot disagree — and the
 * seam holds itself to the rule it imposes on every capability: `controlPlaneRouteDescriptors` is
 * checked against the mounted router by `missingAdminRoutes` in `routeContract.test.ts`.
 *
 * `ping` carries a null scope. It requires a verified caller and no authorization, and saying so is
 * how a client knows it can always prove a key — including on a connection granted nothing at all.
 */
export function controlPlaneRouteDescriptors(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      operation: "ping",
      path: `${basePath}/ping`,
      scope: null,
      summary: "Prove connectivity and which key answered. Always available to a verified caller.",
    },
    {
      method: "GET",
      operation: "manifest.read",
      path: `${basePath}/manifest`,
      scope: MANIFEST_READ_SCOPE,
      summary: "What this Worker composes, and how to call each capability's admin surface.",
    },
    {
      method: "GET",
      operation: "keys.list",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "The registered keys, their validity windows, and their ages.",
    },
    {
      method: "POST",
      operation: "keys.register",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "Register a successor public key. Signed with the key it replaces; appends only.",
    },
    {
      method: "POST",
      operation: "keys.expire",
      path: `${basePath}/keys/:keyId/expire`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "Retire a superseded key. Must be signed with the successor it names as proven.",
    },
    {
      method: "GET",
      operation: "migrations.read",
      path: `${basePath}/migrations`,
      scope: MIGRATIONS_READ_SCOPE,
      summary:
        "What each bound database has applied, what is pending, what is undeclared, and which run put it there. Undeclared is relative to this Worker.",
    },
    {
      method: "GET",
      operation: "privacy.read",
      path: `${basePath}/privacy`,
      scope: PRIVACY_READ_SCOPE,
      summary:
        "Every stored schema holding a privacy-marked field, each field's path and class, and where it lives. Derived from the running code.",
    },
    {
      method: "GET",
      operation: "evidence.read",
      path: `${basePath}/evidence`,
      scope: EVIDENCE_READ_SCOPE,
      summary:
        "SOC 2 and ISO 27001 evidence derived from what this Worker composes and records: each control's facts, their sources, and what could be said. Evidence for an auditor, never a judgment.",
    },
    {
      method: "GET",
      operation: "processing.read",
      path: `${basePath}/processing`,
      scope: PROCESSING_READ_SCOPE,
      summary:
        "The record of processing activities, GDPR Article 30: each purpose, its data classes, legal basis, recipients, retention and measures, and every gap named.",
    },
    {
      method: "GET",
      operation: "erasure.list",
      path: `${basePath}/erasure`,
      scope: ERASURE_READ_SCOPE,
      summary:
        "Every purge in a period: how many completed, are in progress or failed, and each failed or overdue one with the step it stopped at.",
    },
    {
      method: "GET",
      operation: "erasure.read",
      path: `${basePath}/erasure/:subjectType/:subjectId`,
      scope: ERASURE_READ_SCOPE,
      summary:
        "One user's or organization's erasure: the deletion, every step erased or kept with its reason, the state, and the audit events that record each.",
    },
    {
      method: "GET",
      operation: "holds.list",
      path: `${basePath}/holds`,
      scope: RETENTION_READ_SCOPE,
      summary:
        "Every legal hold, standing first: its subject, who placed it and why, and when and why it was released.",
    },
    {
      method: "POST",
      operation: "holds.place",
      path: `${basePath}/holds`,
      scope: RETENTION_HOLD_SCOPE,
      summary:
        "Place a legal hold on a user, an organization or a tenant's audit trail, with a reason. Every purge, prune and inactivity deletion touching it stops until it is released.",
    },
    {
      method: "POST",
      operation: "holds.release",
      path: `${basePath}/holds/:holdId/release`,
      scope: RETENTION_HOLD_SCOPE,
      summary: "Release a legal hold, with a reason. The subject returns to the retention the Worker deploys with.",
    },
    {
      method: "POST",
      operation: "presence.tickets.mint",
      path: `${basePath}/presence/tickets`,
      // Null because no one scope covers it: the call needs the scope of the room kind its body names, which
      // each kind states in the manifest. Its gate resolves that scope from the body and verifies against it.
      scope: null,
      summary:
        "Mint a single-use ticket into one presence room. Needs the room kind's own scope, which the manifest lists beside each kind.",
    },
  ];
}

export function registerControlPlaneRoutes(
  app: Hono<PithyHonoEnv>,
  basePath: string,
  deps: ControlPlaneHandlerDeps,
): void {
  app.get(
    `${basePath}/ping`,
    describeRoute({
      summary: "Prove the connection and the key it signs with.",
      verification: "control-plane",
      responses: { 200: ControlPlanePingResponse },
    }),
    requireControlPlane(ANY_VERIFIED_CALLER),
    pingHandler(deps),
  );

  app.get(
    `${basePath}/manifest`,
    describeRoute({
      summary: "Describe what this Worker composes and how to call its admin surface.",
      verification: "control-plane",
      scopes: [MANIFEST_READ_SCOPE],
      responses: { 200: ControlPlaneManifest },
    }),
    requireControlPlane(MANIFEST_READ_SCOPE),
    manifestHandler(deps),
  );

  app.get(
    `${basePath}/keys`,
    describeRoute({
      summary: "Read the connection's key registration state.",
      verification: "control-plane",
      scopes: [KEYS_ROTATE_SCOPE],
      responses: { 200: ControlPlaneKeysResponse },
    }),
    requireControlPlane(KEYS_ROTATE_SCOPE),
    listKeysHandler(deps),
  );

  app.post(
    `${basePath}/keys`,
    describeRoute({
      summary: "Register a key for the connection.",
      verification: "control-plane",
      scopes: [KEYS_ROTATE_SCOPE],
      responses: { 201: RegisterKeyResponse },
    }),
    requireControlPlane(KEYS_ROTATE_SCOPE),
    validate("json", RegisterKeyRequest),
    (c) => registerKeyHandler(deps)(c, c.req.valid("json")),
  );

  app.post(
    `${basePath}/keys/:keyId/expire`,
    describeRoute({
      summary: "Retire a superseded key.",
      description: "Must be signed with the successor it names as proven.",
      verification: "control-plane",
      scopes: [KEYS_ROTATE_SCOPE],
      responses: { 200: ExpireKeyResponse },
    }),
    requireControlPlane(KEYS_ROTATE_SCOPE),
    validate("param", ExpireKeyParams),
    validate("json", ExpireKeyRequest),
    (c) => expireKeyHandler(deps)(c, c.req.valid("param"), c.req.valid("json")),
  );

  app.get(
    `${basePath}/migrations`,
    describeRoute({
      summary: "Report where each database this Worker binds stands.",
      description:
        "Applied, pending and undeclared migrations per database, each naming its namespace, and the last group with whether it is still reversible. Undeclared is relative to this Worker: a database shared with another Worker lists that Worker's migrations there. Read-only.",
      verification: "control-plane",
      scopes: [MIGRATIONS_READ_SCOPE],
      responses: { 200: ControlPlaneMigrationsResponse },
    }),
    requireControlPlane(MIGRATIONS_READ_SCOPE),
    migrationsHandler(deps),
  );

  app.get(
    `${basePath}/privacy`,
    describeRoute({
      summary: "Report every stored field marked with a privacy class.",
      description:
        "Every D1 table and KV store this Worker composed that holds a privacy-marked field, with each field's path, its class and where it is stored, beside the declared-and-observed posture. Derived at runtime from the deployed schemas. Read-only.",
      verification: "control-plane",
      scopes: [PRIVACY_READ_SCOPE],
      responses: { 200: ControlPlanePrivacyResponse },
    }),
    requireControlPlane(PRIVACY_READ_SCOPE),
    privacyHandler(deps),
  );

  app.get(
    `${basePath}/evidence`,
    describeRoute({
      summary: "Report the evidence this Worker derives for SOC 2 and ISO 27001.",
      description:
        "Seven controls, each with its SOC 2 and ISO/IEC 27001:2022 references, the facts read, the declaration each came from, and `evidenced`, `gap` or `not-derivable` with the reason. Derived from what this Worker composes and records. Evidence for an auditor to weigh, never a judgment. A fact another read keeps behind its own scope stays behind it. Read-only.",
      verification: "control-plane",
      scopes: [EVIDENCE_READ_SCOPE],
      responses: { 200: ControlPlaneEvidenceResponse },
    }),
    requireControlPlane(EVIDENCE_READ_SCOPE),
    evidenceHandler(deps),
  );

  app.get(
    `${basePath}/processing`,
    describeRoute({
      summary: "Report the record of processing activities.",
      description:
        "Every processing activity the composed capabilities and the `processing` block declare: its purpose, the data classes it uses cross-checked against the privacy inventory, its legal basis or a gap, a consent basis's purpose and grant counts, its recipients with what each receives, its effective retention, and the evidence pack's controls. Every gap is named and none is filled in. It describes the processing and changes none of it. Read-only.",
      verification: "control-plane",
      scopes: [PROCESSING_READ_SCOPE],
      responses: { 200: ControlPlaneProcessingResponse },
    }),
    requireControlPlane(PROCESSING_READ_SCOPE),
    processingHandler(deps),
  );

  app.get(
    `${basePath}/erasure`,
    describeRoute({
      summary: "Report every purge in a period.",
      description:
        "Every user and organization purge that came due, ran a step, failed or completed in the window: counts of scheduled, in progress, complete, failed and overdue, and each failed or overdue one named with the step it stopped at. The window defaults to the 90 days before `until`, and is at most 366 days. Read-only.",
      verification: "control-plane",
      scopes: [ERASURE_READ_SCOPE],
      responses: { 200: ControlPlaneErasurePeriodResponse },
    }),
    requireControlPlane(ERASURE_READ_SCOPE),
    validate("query", ErasurePeriodQuery),
    (c) => erasurePeriodHandler(deps)(c, c.req.valid("query")),
  );

  app.get(
    `${basePath}/erasure/:subjectType/:subjectId`,
    describeRoute({
      summary: "Attest one subject's erasure.",
      description:
        "For one user or organization: when it was deleted, by which kind of actor and why, soft or hard, every purge step with its capability, whether it erased or kept the rows and why, and when it finished, the purge's state, and the audit events that record each step by event id and chain position. Nothing about the subject beyond its id. Read-only.",
      verification: "control-plane",
      scopes: [ERASURE_READ_SCOPE],
      responses: { 200: ControlPlaneErasureSubjectResponse },
    }),
    requireControlPlane(ERASURE_READ_SCOPE),
    validate("param", ErasureSubjectParams),
    (c) => erasureSubjectHandler(deps)(c, c.req.valid("param")),
  );

  app.get(
    `${basePath}/holds`,
    describeRoute({
      summary: "List the legal holds.",
      description:
        "Every hold, standing first and newest first within each: the subject, who placed it and why, and when, by whom and why it was released. `active` counts the holds standing. Read-only.",
      verification: "control-plane",
      scopes: [RETENTION_READ_SCOPE],
      responses: { 200: ControlPlaneHoldsResponse },
    }),
    requireControlPlane(RETENTION_READ_SCOPE),
    validate("query", HoldListQuery),
    (c) => listHoldsHandler(deps)(c, c.req.valid("query")),
  );

  app.post(
    `${basePath}/holds`,
    describeRoute({
      summary: "Place a legal hold.",
      description:
        "Holds one user, one organization, or one tenant's audit trail, with a reason. While it stands no purge, prune or inactivity deletion touches the subject, and a purge already running stops at its next step. Audited. A hold can only preserve: nothing here shortens a retention.",
      verification: "control-plane",
      scopes: [RETENTION_HOLD_SCOPE],
      responses: { 201: ControlPlaneHoldResponse },
    }),
    requireControlPlane(RETENTION_HOLD_SCOPE),
    validate("json", PlaceHoldRequest),
    (c) => placeHoldHandler(deps)(c, c.req.valid("json")),
  );

  app.post(
    `${basePath}/holds/:holdId/release`,
    describeRoute({
      summary: "Release a legal hold.",
      description:
        "Ends one standing hold, with a reason, and keeps it as a record. The subject returns to the Worker's retention; a purge it stopped resumes on the next daily pass. Audited.",
      verification: "control-plane",
      scopes: [RETENTION_HOLD_SCOPE],
      responses: { 200: ControlPlaneHoldResponse },
    }),
    requireControlPlane(RETENTION_HOLD_SCOPE),
    validate("param", HoldParams),
    validate("json", ReleaseHoldRequest),
    (c) => releaseHoldHandler(deps)(c, c.req.valid("param"), c.req.valid("json")),
  );

  app.post(
    `${basePath}/presence/tickets`,
    describeRoute({
      summary: "Mint a presence ticket for a management client.",
      description:
        "Admits the participant the body names to one room of any kind this Worker composes. Sign the call with the room kind's own scope, as the manifest lists it; presence adds no scope. Single use, for 60 seconds. Open the socket at `socketPath`, offering `protocol` and `pithy.ticket.<ticket>` in `Sec-WebSocket-Protocol`.",
      verification: "control-plane",
      responses: { 201: PresenceTicket },
    }),
    presenceTicketGate(deps),
    validate("json", ControlPlanePresenceTicketRequest),
    (c) => presenceTicketHandler(deps)(c, c.req.valid("json")),
  );
}
