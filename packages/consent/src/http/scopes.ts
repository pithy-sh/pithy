// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRouteDeclaration } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Consent's control-plane scope, and the admin surface a manifest advertises.
 *
 * **Separate from the routes because a scope name is a client's business**: the dashboard's scope builder
 * reads these constants in a browser program with no Workers types, so this module imports types and nothing else.
 *
 * - `consent:read` reads the record an auditor reads — counts, a subject's rows with
 *   their typed and representative names, the documents and the signature images — and changes nothing: there is
 *   no control-plane write here, because consent is the person's to give and to take back.
 */

/** Read counts per purpose and version, a subject's record, and the documents and evidence behind it. */
export const CONSENT_READ_SCOPE: ControlPlaneScope = "consent:read";

/** Every control-plane scope consent defines — what `pithy dashboard connect` offers for this capability. */
export const CONSENT_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [CONSENT_READ_SCOPE];

/**
 * Consent's management surface, as `GET /control-plane/manifest` reports it. `basePath` is a parameter, never a
 * default, so an adopter who mounted consent elsewhere gets a manifest naming where it is. Everything sits under
 * `control-plane/`, which the person's own routes never use.
 */
export function consentAdminRoutes(basePath: string): AdminRouteDeclaration[] {
  return [
    {
      method: "GET",
      path: `${basePath}/control-plane/purposes`,
      scope: CONSENT_READ_SCOPE,
      kind: "reads",
      operation: "purposes.read",
      summary: "Every consent purpose, with counts of current grants and withdrawals per notice version.",
    },
    {
      method: "GET",
      path: `${basePath}/control-plane/subjects/:kind/:subjectId`,
      scope: CONSENT_READ_SCOPE,
      kind: "reads",
      operation: "subjects.read",
      summary: "One subject's consent record: where they stand, every row, and the merges behind it.",
    },
    {
      method: "GET",
      path: `${basePath}/control-plane/documents/:hash`,
      scope: CONSENT_READ_SCOPE,
      kind: "reads",
      operation: "documents.read",
      summary: "A signed document, byte for byte, by its content hash.",
    },
    {
      method: "GET",
      path: `${basePath}/control-plane/evidence/:hash`,
      scope: CONSENT_READ_SCOPE,
      kind: "reads",
      operation: "evidence.read",
      summary: "A drawn signature or a provider's certificate, by its content hash.",
    },
  ];
}
