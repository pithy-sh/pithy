// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The `pithy add controlplane` surface — **not a barrel over `@pithy-sh/core`.**
 *
 * `pithy add` writes `import { <name> } from "<package>/src/index";` into a Worker's `pithy.config.ts`,
 * so a capability has to be reachable at its package's `src/index`. Core ships one capability — the
 * `control-plane` seam — and this file exists to name it and nothing else.
 *
 * Everything else in core stays deep-imported (`@pithy-sh/core/src/error/pithyError`,
 * `@pithy-sh/core/src/data/codecs`), which is the rule and which nothing here relaxes. The exports
 * below are the ones an adopter's own code plausibly touches: the factory their config calls, the
 * config schema behind it, the table and row schemas they may read against, the audit actions their
 * queries filter on, and — because the seam is MIT and never gated — the minting side, so "build your
 * own management client" is a real option rather than a slogan.
 *
 * `@pithy-sh/storage/src/index.ts` documents itself the same way, for the same reason.
 */

export { type ControlPlaneAuditAction, ControlPlaneAuditActions } from "./controlPlane/audit/actions";
export {
  CONTROL_PLANE_KV_BINDING,
  CONTROLPLANE_MIGRATION_ORDER,
  type ControlPlaneCapability,
  type ControlPlaneOptions,
  controlplane,
  isControlPlaneCapability,
} from "./controlPlane/capability";
export { ControlPlaneConfig, type ControlPlaneConfigInput } from "./controlPlane/config/config";
export { ControlPlaneContext } from "./controlPlane/context";
export { ControlPlaneConnection, Ed25519PublicJwk, RegisteredKey } from "./controlPlane/data/connection";
export {
  CONTROL_PLANE_CONNECTIONS_TABLE,
  type ControlPlaneDatabase,
  controlPlaneDatabase,
} from "./controlPlane/data/tables";
// The manifest a management client parses, and the shape a capability declares its admin surface in.
// Both are exported for the same reason the minting side is: writing your own client has to be a real
// option, and a client that had to re-derive this contract from the docs would drift from it.
export {
  AdminRoute,
  type AdminRouteMethod,
  CapabilityDescriptor,
  ControlPlaneManifest,
} from "./controlPlane/discovery/adminRoute";
export { type AdminRouteDrift, missingAdminRoutes } from "./controlPlane/discovery/drift";
export { requireControlPlane } from "./controlPlane/http/guard";
export {
  ANY_VERIFIED_CALLER,
  type ControlPlaneRequirement,
  ControlPlaneScope,
  KEYS_ROTATE_SCOPE,
  MANIFEST_READ_SCOPE,
  SEAM_SCOPES,
} from "./controlPlane/scope/scope";
export { exportPublicJwk, type MintControlPlaneToken, mintControlPlaneToken } from "./controlPlane/token/mint";
// The wire contract, from the module that imports nothing: a management client is often a browser
// calling the adopter's Worker directly, and it must be able to name these headers without dragging
// the verifier — and WebCrypto with it — into a DOM-typed build.
export { CONTROL_PLANE_HEADER, CONTROL_PLANE_VERSION_HEADER } from "./controlPlane/wire";
