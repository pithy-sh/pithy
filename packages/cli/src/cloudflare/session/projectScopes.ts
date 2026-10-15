// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sessionScopes } from "@pithy-sh/cloudflare/src/oauth/scopes";
import type { PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import {
  type ProfileOverride,
  resolveTokenProfiles,
  type TokenProfile,
} from "@pithy-sh/cloudflare/src/tokens/profiles";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { resolveWorkerSetFor } from "../../project/composeFor";
import { loadProject, loadProjectEnvironments } from "../../project/config";
import { isUnknown } from "../../project/workerScope";
import { tokenOverrideResolver } from "../../tokens/config";
import { declaredRouteZones } from "../../tokens/routeZones";
import { tokenProfiles } from "../../tokens/workerProfiles";

/** What {@link deriveSessionScopes} reads: the project, already loaded, as the questions it answers. */
export interface ScopeFacts {
  /** Every environment the project has: the local one and each declared one. */
  environments: readonly string[];
  /** The token profiles the project composes in that environment. */
  profilesFor: (environment: string) => Record<string, TokenProfile>;
  /** Whether any Worker declares a domain in that environment, so `ci-system` carries route writes there. */
  declaresDomain: (environment: string) => boolean;
  /** The adopter's override of a profile, from `tokens.overrides` in the root config. */
  override: (profile: string) => ProfileOverride | undefined;
}

/**
 * **The scopes a sign-in asks for, derived from what the project's tokens carry (#759).**
 *
 * A session can mint only what it could do itself — Cloudflare refuses a mint whose permission groups the
 * session's scopes do not cover — so the request is the union, over every environment and every profile
 * the project composes there, of the permissions those tokens carry. An adopter's override counts as
 * written, because that is what the mint will ask for. `routes:write` is added where a domain is declared,
 * because that is the one permission the mint adds outside a profile (#651).
 *
 * Nothing is listed by hand, so a capability the project does not compose contributes nothing — to the
 * request, or to the consent screen the adopter reads.
 */
export function deriveSessionScopes(facts: ScopeFacts): string[] {
  const keys: PermissionKey[] = [];
  const add = (key: PermissionKey) => {
    if (!keys.includes(key)) keys.push(key);
  };
  for (const environment of facts.environments) {
    for (const [name, profile] of Object.entries(facts.profilesFor(environment))) {
      for (const key of facts.override(name)?.permissions ?? profile.permissions) add(key);
    }
    if (facts.declaresDomain(environment)) add("routes:write");
  }
  return sessionScopes(keys);
}

/**
 * The scopes for the project at `projectDir`, or — where there is no project yet — for the `ci-system`
 * token a project with no capabilities would mint. `pithy cloudflare connect` before `pithy init` is an
 * ordinary order to do things in, and `init` needs the account and its zones.
 *
 * A capability set that cannot be read is refused, never narrowed: `tokenProfiles` says why — a session
 * derived from a partial set cannot mint what the full set carries.
 */
export async function projectSessionScopes(
  projectDir: string,
  options: { environments?: readonly string[] } = {},
): Promise<{ scopes: string[]; project: boolean }> {
  let config: Awaited<ReturnType<typeof loadProject>>;
  try {
    config = await loadProject(projectDir);
  } catch (error) {
    // Only an absent config means "no project here". A config that exists and will not load is refused,
    // never read as no project: that would ask for less than the project's tokens carry, and the narrower
    // session would be refused at its first mint.
    if (!(error instanceof PithyError && error.payload.code === "core/not_found")) throw error;
    const profiles = resolveTokenProfiles([]);
    return {
      scopes: deriveSessionScopes({
        environments: [LOCAL_ENVIRONMENT],
        profilesFor: () => profiles,
        declaresDomain: () => false,
        override: () => undefined,
      }),
      project: false,
    };
  }
  // Every environment for a sign-in, which must cover all of them; one, for a mint's consent check, which
  // asks only about the environment it mints for — a broken set elsewhere is not this mint's to refuse.
  const environments = options.environments ?? [LOCAL_ENVIRONMENT, ...loadProjectEnvironments(config)];
  const sets = new Map<string, Awaited<ReturnType<typeof resolveWorkerSetFor>>>();
  for (const environment of environments) sets.set(environment, await resolveWorkerSetFor(environment, { projectDir }));
  const setFor = (environment: string) => {
    const set = sets.get(environment);
    if (set === undefined) throw new InternalError({ message: `No worker set was resolved for ${environment}.` });
    return set;
  };
  return {
    scopes: deriveSessionScopes({
      environments,
      profilesFor: (environment) => tokenProfiles(setFor(environment)),
      declaresDomain: (environment) => {
        const set = setFor(environment);
        return !isUnknown(set) && declaredRouteZones(set, environment).length > 0;
      },
      override: tokenOverrideResolver(config),
    }),
    project: true,
  };
}
