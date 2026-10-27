// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import { ArtifactsConfig, type ArtifactsConfigInput, parseArtifactsConfig } from "./config/config";
import { artifactsTables } from "./data/tables";
import { ArtifactsInvalidConfigError } from "./error/errors";
import { type RepoNameSeam, registerArtifactsRoutes } from "./http/routes";
import { artifacts_0001_init } from "./migrations/0001_init";
import { artifactsUserPurge } from "./purge/contribution";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

/**
 * Where this capability's migrations sort in the app database. Allocated in
 * `packages/cli/src/migrations/orders.test.ts`, the one place an order is handed out.
 */
export const ARTIFACTS_MIGRATION_ORDER = 1500;

export type ArtifactsOptions = ArtifactsConfigInput & {
  /**
   * Your own convention for a repository's physical name, the one in its clone URL. Without it the name is a random
   * UUID. With it, uniqueness is yours: a collision is refused as `artifacts/name_taken`, and the name is held to
   * Cloudflare's charset and the 2-to-63 cap, refused rather than shortened.
   */
  repoName?: RepoNameSeam;
};

/** The artifacts capability, with its resolved config attached. */
export interface ArtifactsCapability extends Capability {
  /** The resolved configuration. */
  artifactsConfig: ArtifactsConfig;
}

/** A composed capability's declared powers, read by shape: the organization capability's catalog. */
function declaredPowers(capability: Capability): readonly string[] | undefined {
  const roles = (capability as { organizationRoles?: { powers?: unknown } }).organizationRoles;
  const powers = roles?.powers;
  return Array.isArray(powers) && powers.every((power) => typeof power === "string") ? powers : undefined;
}

/**
 * **Real Git repositories for your own customers, backed by Cloudflare Artifacts.**
 *
 * The kit owns what is the same in every product: a repository's identity and its two names, who owns it, who may
 * read and who may push, a short-lived token minted against that, and in-Worker reads. You name your repositories
 * however you like, and you decide what your own roles mean.
 *
 * `organization` is optional and never imported. Without it every repository is a person's, and the organization
 * routes do not mount. With it, a repository may be an organization's, and managing those is gated on the power you
 * name as `managePower` — required, and refused at boot when your role catalog does not declare it. Auth is a seam
 * too: without it every route is denied.
 */
export function artifacts(options: ArtifactsOptions = {}): ArtifactsCapability {
  const { repoName, ...configInput } = options;
  const resolved = parseArtifactsConfig(configInput);

  /** Filled by `compose`, which runs before any route mounts. */
  const wiring = { organization: false };

  const migrations: Record<string, Migration> = { "0001_init": artifacts_0001_init };
  const requiredBindings: BindingSpecInput[] = [
    // The app database: the repository and grant tables live there, beside the users they name.
    { type: "d1", name: "DB" },
    // The namespace of repositories, one per environment, named `<project>-<env>` by `pithy add` and `pithy provision`.
    { type: "artifacts", name: resolved.binding },
  ];

  const capability = defineCapability({
    name: "artifacts",
    // Stamped by `scripts/stampVersions.ts` — a Worker cannot read its own package.json.
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    requiredBindings,
    // The organization power this capability gates on, declared so tenancy refuses a catalog that places it on no
    // role. Absent until the adopter names one.
    ...(resolved.managePower !== undefined ? { powers: [resolved.managePower] } : {}),
    compose: ({ capabilities }) => {
      const tenancy = capabilities.find((candidate) => candidate.name === "organization");
      wiring.organization = tenancy !== undefined;
      if (!tenancy) return;
      // **Named, never inferred.** A capability reserving a power of its own would be one more name in a catalog
      // that is closed, so the adopter names it, exactly as they name `administrativePower`.
      if (resolved.managePower === undefined) {
        throw new ArtifactsInvalidConfigError({
          message: "organization is composed, and artifacts names no managePower.",
          action:
            'Pass artifacts({ managePower: "repos:manage" }), with a power your role catalog declares and a role holds.',
          detail: "an organization's repositories are managed under a power the adopter names; none was named",
        });
      }
      const powers = declaredPowers(tenancy);
      if (powers !== undefined && !powers.includes(resolved.managePower)) {
        throw new ArtifactsInvalidConfigError({
          message: `artifacts names managePower \`${resolved.managePower}\`, which your role catalog does not declare.`,
          action: "Declare it in defineRoles({ powers }) and give it to the role meant to manage repositories.",
          detail: `declared powers: ${powers.join(", ")}`,
        });
      }
    },
    config: ArtifactsConfig,
    databases: {
      app: {
        binding: "DB",
        tables: artifactsTables(),
        migrationOrder: ARTIFACTS_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerArtifactsRoutes({
      config: resolved,
      ...(repoName ? { repoName } : {}),
      organization: () => wiring.organization,
    }),
    // A person's own repositories and the grants they hold: exported on an access request and erased by their purge,
    // as its own step in the adopter's Worker (#814).
    purge: [artifactsUserPurge(resolved.binding)],
  });

  return Object.assign(capability, { artifactsConfig: resolved });
}

/** Whether a composed capability is this one. */
export function isArtifactsCapability(capability: Capability): capability is ArtifactsCapability {
  return capability.name === "artifacts" && "artifactsConfig" in capability;
}
