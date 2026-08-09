// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability, TokenProfileSeam } from "@pithy-sh/core/src/capability/capability";
import { CloudflareNotConfiguredError } from "../client/errors";
import { accountResource, type TokenPermission } from "./accountTokensManager";
import { isPermissionKey, type PermissionKey, resolvePermissionKeys } from "./permissions";

/**
 * Where a minted token's value is written.
 *
 * - `secrets-store` — the CF Secrets Store; a Worker reads it via its binding. The destination for a
 *   worker-consumer token; resolved from the token's declared secret (its registry backend) unless a
 *   profile or `--store` names it directly.
 * - `dev-vars` — `<config>/<project>/tokens.json`, keyed by environment and outside every checkout.
 *   **Read by an operator, never by a command** — nothing resolves a credential from it. The store for
 *   the `ci-system` token: mint it here, read the value
 *   out, and set it as CI's `CLOUDFLARE_API_TOKEN`. It wrote `.dev.vars.<env>` *inside* the project until
 *   #182; the name stays because it is a public `--store` flag value.
 * - `ephemeral` — nothing is written; the value is used in-process and discarded. The one-step CI
 *   path — CI can't read the CF Secrets Store, so it mints and uses the token in the same job.
 */
export type TokenStore = "secrets-store" | "dev-vars" | "ephemeral";

/** The valid stores, for validating a `--store` flag or a profile's `defaultStore`. */
export const TOKEN_STORES: readonly TokenStore[] = ["secrets-store", "dev-vars", "ephemeral"];

/** The name of the one CI system token — the single least-privilege credential a CI pipeline runs under. */
export const CI_SYSTEM_PROFILE = "ci-system";

/**
 * The base permissions the `ci-system` token always carries: deploy Workers, run migrations against
 * remote D1, and read/write the Secrets Store (a deployed Worker binding CFSS secrets needs Secrets
 * Store access at deploy). Every composed capability's {@link Capability.ciPermissions} unions on top.
 */
const CI_SYSTEM_BASE: readonly PermissionKey[] = [
  "workers:write",
  "d1:read",
  "d1:write",
  "secrets:read",
  "secrets:write",
];

/**
 * A named token profile: the CF permissions a job needs (short {@link PermissionKey}s), the resource
 * scope, the **secret** its minted value is stored under (whose registry backend is the destination),
 * and an optional built-in store override. The consuming code is the source of truth for its access;
 * adopters override any field per profile.
 */
export interface TokenProfile {
  /** The profile's stable name — the key it is minted, listed, and revoked under. */
  name: string;
  /** The CF permissions the token grants, as short catalog keys (resolved to group names at mint). */
  permissions: PermissionKey[];
  /** The resource scope: `"account"` (the default) or an explicit CF resource map. */
  resources?: "account" | Record<string, string>;
  /** The secret-registry name the minted value is stored under; its declared backend is the destination. */
  secret: string;
  /**
   * Whether the value behind {@link secret} differs per environment (the default) or is one value every
   * environment shares. It decides the environment segment of the **CF Secrets Store entry name** the
   * minted value is written to, and nothing else — never the variable key, which is a variable name
   * and stays verbatim. A `global` profile writes one entry with the literal `global` in that slot,
   * matching what provisioning wrote; an `environment` profile writes one entry per environment.
   */
  secretScope?: TokenSecretScope;
  /** A built-in destination override (`dev-vars`/`ephemeral`/`secrets-store`); else the secret's backend. */
  defaultStore?: TokenStore;
  /** Why this profile exists / what job consumes it. */
  description: string;
}

/** Whether a profile's secret is one value per environment or one value shared by all of them. */
export type TokenSecretScope = "environment" | "global";

/** The valid secret scopes, for validating a capability's declaration. */
const TOKEN_SECRET_SCOPES: readonly TokenSecretScope[] = ["environment", "global"];

/** An adopter's override of a profile's defaults (from `pithy.config.ts` or CLI flags). Every field optional. */
export interface ProfileOverride {
  /** Replace the profile's permission keys. */
  permissions?: PermissionKey[];
  /** Replace the profile's resource scope with an explicit CF resource map. */
  resources?: Record<string, string>;
  /** Replace where the value is written (`--store`). */
  store?: TokenStore;
}

/** The env-var / secret name a profile's token is stored under: `CF_TOKEN_<PROFILE>`. */
export function tokenSecretName(profile: string): string {
  return `CF_TOKEN_${profile.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Author a token profile: validates its permission keys against the catalog at author time, so a typo
 * fails where the profile is declared, not deep in a mint call. Returns the profile unchanged, typed.
 */
export function defineTokenProfile(profile: TokenProfile): TokenProfile {
  resolvePermissionKeys(profile.permissions); // throws on an unknown key
  return profile;
}

/** Validate a capability's declared permission keys, throwing an actionable error on any unknown one. */
function assertPermissionKeys(keys: readonly string[], where: string): PermissionKey[] {
  for (const key of keys) {
    if (!isPermissionKey(key)) {
      throw new CloudflareNotConfiguredError({
        message: `${where} declares an unknown permission key: ${key}.`,
        action:
          "Use a known permission key (d1:read, d1:write, workers:write, secrets:read, secrets:write, email:routing, kv:write).",
      });
    }
  }
  return keys as PermissionKey[];
}

/** Build the aggregating `ci-system` profile: the base permissions ∪ every capability's `ciPermissions`. */
function ciSystemProfile(capabilities: readonly Capability[]): TokenProfile {
  const permissions: PermissionKey[] = [...CI_SYSTEM_BASE];
  for (const capability of capabilities) {
    for (const key of assertPermissionKeys(capability.ciPermissions ?? [], `Capability "${capability.name}"`)) {
      if (!permissions.includes(key)) permissions.push(key);
    }
  }
  return {
    name: CI_SYSTEM_PROFILE,
    permissions,
    secret: tokenSecretName(CI_SYSTEM_PROFILE),
    defaultStore: "dev-vars",
    description:
      "The one CI pipeline credential: deploy Workers, migrate, and every composed capability's CI needs. Set it as CI's CLOUDFLARE_API_TOKEN.",
  };
}

/**
 * The seam fields this package reads. Core's {@link TokenProfileSeam} is the structural contract every
 * capability declares against; `secretScope` is additive on top of it, so it is named here rather than
 * in core — a seam value that omits it is still assignable, and one that carries it is read as declared.
 *
 * Exported so a capability can type its `tokenProfiles` entry against it. Declaring `secretScope` as an
 * inline object literal directly in `tokenProfiles` still trips TypeScript's excess-property check
 * against core's narrower `TokenProfileSeam`; declare the entry as its own `const` (with `as const` or
 * `satisfies TokenProfileSeamInput`) and it flows through.
 */
export interface TokenProfileSeamInput extends TokenProfileSeam {
  readonly secretScope?: string;
}

/** Build a concrete, validated worker-consumer {@link TokenProfile} from a capability's structural seam entry. */
function profileFromSeam(name: string, seam: TokenProfileSeamInput, capability: string): TokenProfile {
  const store = seam.defaultStore;
  if (store !== undefined && !(TOKEN_STORES as readonly string[]).includes(store)) {
    throw new CloudflareNotConfiguredError({
      message: `Token profile "${name}" (capability "${capability}") declares an unknown store: ${store}.`,
      action: `Use one of: ${TOKEN_STORES.join(", ")}.`,
    });
  }
  const scope = seam.secretScope;
  if (scope !== undefined && !(TOKEN_SECRET_SCOPES as readonly string[]).includes(scope)) {
    throw new CloudflareNotConfiguredError({
      message: `Token profile "${name}" (capability "${capability}") declares an unknown secret scope: ${scope}.`,
      action: `Use one of: ${TOKEN_SECRET_SCOPES.join(", ")}.`,
    });
  }
  return {
    name,
    permissions: assertPermissionKeys(seam.permissions, `Token profile "${name}"`),
    resources: seam.resources,
    secret: seam.secret ?? tokenSecretName(name),
    secretScope: scope as TokenSecretScope | undefined,
    defaultStore: store as TokenStore | undefined,
    description: seam.description ?? name,
  };
}

/**
 * The project's token-profile registry: the aggregating `ci-system` profile plus every composed
 * capability's worker-consumer {@link Capability.tokenProfiles} slice. A capability profile that
 * clashes with `ci-system` (or another capability's name) fails loudly at assembly. This is the one
 * registry `pithy token` reads.
 */
export function resolveTokenProfiles(capabilities: readonly Capability[]): Record<string, TokenProfile> {
  const profiles: Record<string, TokenProfile> = { [CI_SYSTEM_PROFILE]: ciSystemProfile(capabilities) };
  for (const capability of capabilities) {
    for (const [name, seam] of Object.entries(capability.tokenProfiles ?? {})) {
      if (profiles[name]) {
        throw new CloudflareNotConfiguredError({
          message: `Token profile "${name}" is declared more than once (capability "${capability.name}").`,
          action: "Give each token profile a unique name.",
        });
      }
      profiles[name] = profileFromSeam(name, seam, capability.name);
    }
  }
  return profiles;
}

/**
 * Resolve a profile by name from the aggregated registry, applying an adopter override. An unknown
 * name fails with an actionable error listing the known profiles.
 */
export function resolveProfile(
  profiles: Record<string, TokenProfile>,
  name: string,
  override?: ProfileOverride,
): TokenProfile {
  const base = profiles[name];
  if (!base) {
    throw new CloudflareNotConfiguredError({
      message: `Unknown token profile: ${name}.`,
      action: `Use one of: ${Object.keys(profiles).join(", ")}.`,
      detail: `resolve token profile: ${name} is not in the registry`,
    });
  }
  if (!override) return base;
  return {
    ...base,
    permissions: override.permissions ?? base.permissions,
    resources: override.resources ?? base.resources,
    defaultStore: override.store ?? base.defaultStore,
  };
}

/** Build the account-scoped {@link TokenPermission}s for a set of permission keys — the mint input. */
export function permissionsForKeys(keys: PermissionKey[], accountId: string): TokenPermission[] {
  return [{ permissionGroupNames: resolvePermissionKeys(keys), resources: accountResource(accountId) }];
}

/**
 * Turn a resolved profile into the {@link TokenPermission}s the account-tokens manager mints from: the
 * profile's permission keys resolved to CF group names, scoped to the account (or the profile's
 * explicit resources). One policy per profile — a token carries exactly the access its profile declares.
 */
export function profilePermissions(profile: TokenProfile, accountId: string): TokenPermission[] {
  const resources =
    profile.resources && profile.resources !== "account" ? profile.resources : accountResource(accountId);
  return [{ permissionGroupNames: resolvePermissionKeys(profile.permissions), resources }];
}
