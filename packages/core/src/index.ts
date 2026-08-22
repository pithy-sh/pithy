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
  CapabilityDeclaration,
  CapabilityDescriptor,
  ControlPlaneManifest,
  type ControlPlaneManifestWire,
} from "./controlPlane/discovery/adminRoute";
// The configured-fact seam: a capability states a decision an adopter already made — what this project
// bills — and a management client respects it rather than guessing at it (#422). Exported whole, for the
// same reason health is: a client reads the values through the declarations that travel with them, and
// one that had to re-derive the contract would drift from it.
export {
  type CapabilityManifestConfig,
  type CapabilityManifestConfigInput,
  defineManifestConfig,
  ManifestConfigKey,
  ManifestConfigValue,
  ManifestConfigValues,
  type NamedConfigValue,
  namedConfigValues,
} from "./controlPlane/discovery/configuration";
export { type AdminRouteDrift, missingAdminRoutes } from "./controlPlane/discovery/drift";
// The health seam: a capability declares a bounded set of scalars about its own state, and the manifest
// carries them — so a client renders "3 secrets need rotating" from the read it already made rather than
// spending a round trip per number (#317). Exported whole, because a client renders the values through
// the declarations that travel with them.
// Split across two modules and exported as one surface: the seam a capability implements needs Hono
// and the `Capability` contract, and the vocabulary a client renders needs neither. A browser importing
// the second must not compile the first (#430).
export {
  type CapabilityHealth,
  type CapabilityHealthInput,
  type CapabilityHealthSource,
  capabilityHealthSources,
  defineCapabilityHealth,
  readCapabilityHealth,
} from "./controlPlane/discovery/health";
export {
  CapabilityHealthReport,
  type CapabilityHealthWire,
  HealthSummary,
  HealthSummaryKey,
  HealthSummaryValue,
  HealthValueCost,
  HealthValueKind,
  healthReport,
  healthWire,
  type NamedHealthValue,
  namedHealthValues,
} from "./controlPlane/discovery/healthSummary";
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
export {
  CONTROL_PLANE_HEADER,
  CONTROL_PLANE_VERSION_CREATED_HEADER,
  CONTROL_PLANE_VERSION_HEADER,
  type WorkerBuild,
  workerBuildChanged,
} from "./controlPlane/wire";
