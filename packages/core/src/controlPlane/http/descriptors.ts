// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRouteDeclaration } from "../discovery/adminRoute";
import {
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_REVOKE_SCOPE,
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
export function controlPlaneRouteDescriptors(basePath: string): AdminRouteDeclaration[] {
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
      kind: "reads",
      summary: "What this Worker composes, and how to call each capability's admin surface.",
    },
    {
      method: "GET",
      operation: "keys.list",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      kind: "credentials",
      summary: "The registered keys, their validity windows, and their ages.",
    },
    {
      method: "POST",
      operation: "keys.register",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      kind: "credentials",
      summary: "Register a successor public key. Signed with the key it replaces; appends only.",
    },
    {
      method: "POST",
      operation: "keys.expire",
      path: `${basePath}/keys/:keyId/expire`,
      scope: KEYS_ROTATE_SCOPE,
      kind: "credentials",
      summary: "Retire a superseded key. Must be signed with the successor it names as proven.",
    },
    {
      method: "GET",
      operation: "connections.list",
      path: `${basePath}/connections`,
      scope: CONNECTIONS_READ_SCOPE,
      kind: "reads",
      summary:
        "Every connection bound to this Worker's environment: who authorized it, what kind of client it is for and why, its credentials, grant and trust constraints, and when it was registered or revoked. No key material.",
    },
    {
      method: "POST",
      operation: "connections.lookup",
      path: `${basePath}/connections/lookup`,
      scope: CONNECTIONS_READ_SCOPE,
      kind: "reads",
      readInBody: true,
      summary:
        "The connections one email authorized, the unattributed apart, as the listing reports them. The address travels in the body, never the URL.",
    },
    {
      method: "POST",
      operation: "connections.revoke",
      path: `${basePath}/connections/:connectionId/revoke`,
      scope: CONNECTIONS_REVOKE_SCOPE,
      kind: "credentials",
      summary:
        "Revoke every key and trust another connection in this environment holds, with a reason. Never the calling connection, which ends through disconnect.",
    },
    {
      method: "GET",
      operation: "migrations.read",
      path: `${basePath}/migrations`,
      scope: MIGRATIONS_READ_SCOPE,
      kind: "reads",
      summary:
        "What each bound database has applied, what is pending, what is undeclared, and which run put it there. Undeclared is relative to this Worker.",
    },
    {
      method: "GET",
      operation: "privacy.read",
      path: `${basePath}/privacy`,
      scope: PRIVACY_READ_SCOPE,
      kind: "reads",
      summary:
        "Every stored schema holding a privacy-marked field, each field's path and class, and where it lives. Derived from the running code.",
    },
    {
      method: "GET",
      operation: "evidence.read",
      path: `${basePath}/evidence`,
      scope: EVIDENCE_READ_SCOPE,
      kind: "reads",
      summary:
        "SOC 2 and ISO 27001 evidence derived from what this Worker composes and records: each control's facts, their sources, and what could be said. Evidence for an auditor, never a judgment.",
    },
    {
      method: "GET",
      operation: "processing.read",
      path: `${basePath}/processing`,
      scope: PROCESSING_READ_SCOPE,
      kind: "reads",
      summary:
        "The record of processing activities, GDPR Article 30: each purpose, its data classes, legal basis, recipients, retention and measures, and every gap named.",
    },
    {
      method: "GET",
      operation: "erasure.list",
      path: `${basePath}/erasure`,
      scope: ERASURE_READ_SCOPE,
      kind: "reads",
      summary:
        "Every purge in a period: how many completed, are in progress or failed, and each failed or overdue one with the step it stopped at.",
    },
    {
      method: "GET",
      operation: "erasure.read",
      path: `${basePath}/erasure/:subjectType/:subjectId`,
      scope: ERASURE_READ_SCOPE,
      kind: "reads",
      summary:
        "One user's or organization's erasure: the deletion, every step erased or kept with its reason, the state, and the audit events that record each.",
    },
    {
      method: "GET",
      operation: "holds.list",
      path: `${basePath}/holds`,
      scope: RETENTION_READ_SCOPE,
      kind: "reads",
      summary:
        "Every legal hold, standing first: its subject, who placed it and why, and when and why it was released.",
    },
    {
      method: "POST",
      operation: "holds.place",
      path: `${basePath}/holds`,
      scope: RETENTION_HOLD_SCOPE,
      kind: "writes",
      summary:
        "Place a legal hold on a user, an organization or a tenant's audit trail, with a reason. Every purge, prune and inactivity deletion touching it stops until it is released.",
    },
    {
      method: "POST",
      operation: "holds.release",
      path: `${basePath}/holds/:holdId/release`,
      scope: RETENTION_HOLD_SCOPE,
      kind: "writes",
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
