// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add artifacts` wires into `pithy.config.ts`. Deliberately narrow: the
 * capability factory and its options, the config, and the shapes an app renders. Every other module is imported by
 * deep path (`@pithy-sh/artifacts/src/...`); this is the documented contract, not a barrel over the package.
 */

export {
  ARTIFACTS_MIGRATION_ORDER,
  type ArtifactsCapability,
  type ArtifactsOptions,
  artifacts,
  isArtifactsCapability,
} from "./capability";
export { ArtifactsConfig, type ArtifactsConfigInput, MAX_TOKEN_TTL_SECONDS } from "./config/config";
export { ArtifactsGrant, ArtifactsOwnerKind } from "./data/records";
export type { RepoNameSeam } from "./http/routes";
