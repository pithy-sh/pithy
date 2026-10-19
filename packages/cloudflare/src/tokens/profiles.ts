// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { CloudflareNotConfiguredError } from "../client/errors";
import { accountResource, type TokenPermission, zoneResources } from "./accountTokensManager";
import {
  isPermissionKey,
  isZoneScopedPermission,
  PERMISSION_GROUPS,
  type PermissionKey,
  resolvePermissionKeys,
} from "./permissions";
import { RUNTIME_PROFILE, RUNTIME_TOKEN_SECRET } from "./runtime";

/**
 * Where a minted token's value is written.
 *
 * - `secrets-store` — the CF Secrets Store; a Worker reads it via its binding. The destination for the
 *   `runtime` token; resolved from the token's declared secret (its registry backend) unless a
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
  /** A built-in destination override (`dev-vars`/`ephemeral`/`secrets-store`); else the secret's backend. */
  defaultStore?: TokenStore;
  /** Why this profile exists / what job consumes it. */
  description: string;
}

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
        action: `Use a known permission key: ${Object.keys(PERMISSION_GROUPS).join(", ")}.`,
      });
    }
  }
  return keys as PermissionKey[];
}

/**
 * Build the aggregating `ci-system` profile: the base permissions ∪ every capability's `ciPermissions` ∪
 * `queues:write` where a composed capability binds a queue ∪ `artifacts:write` where one binds Artifacts.
 *
 * **The queue permission is derived from the binding, not declared (#662).** `pithy provision` creates the queue
 * behind every `queue` binding it composes, the adopter's own app's included, and the app has no `ciPermissions`
 * anyone would think to write. A permission read off the binding cannot be forgotten by whoever declares it.
 */
function ciSystemProfile(capabilities: readonly Capability[]): TokenProfile {
  const permissions: PermissionKey[] = [...CI_SYSTEM_BASE];
  for (const capability of capabilities) {
    for (const key of assertPermissionKeys(capability.ciPermissions ?? [], `Capability "${capability.name}"`)) {
      if (!permissions.includes(key)) permissions.push(key);
    }
  }
  const bindsQueue = capabilities.some((capability) =>
    capability.requiredBindings.some((binding) => binding.type === "queue"),
  );
  if (bindsQueue && !permissions.includes("queues:write")) permissions.push("queues:write");
  // **And `artifacts:write` where one binds Artifacts (#673)**, for the same reason: `pithy feature destroy` reaps
  // every repo in the feature's namespace under this token, and the app that binds it declares no `ciPermissions`.
  const bindsArtifacts = capabilities.some((capability) =>
    capability.requiredBindings.some((binding) => binding.type === "artifacts"),
  );
  if (bindsArtifacts && !permissions.includes("artifacts:write")) permissions.push("artifacts:write");
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
 * Build the aggregating `runtime` profile: every composed capability's `runtimePermissions`, each once,
 * in first-declared order — or nothing, when the composition declares none.
 *
 * **One token per deployed application, the way `ci-system` is one per pipeline.** A capability names
 * what its Workers call Cloudflare with and never a token of its own, so a second credential is not
 * something a capability can ask for. The token is minted per environment into the Secrets Store, so
 * revoking staging's leaves production reading. A key whose group is zone-scoped is refused here: a
 * Worker's token is account-scoped, and its zones would have to be chosen by hand.
 */
function runtimeProfile(capabilities: readonly Capability[]): TokenProfile | undefined {
  const permissions: PermissionKey[] = [];
  for (const capability of capabilities) {
    const where = `Capability "${capability.name}"`;
    const keys = assertPermissionKeys(capability.runtimePermissions ?? [], where);
    assertAccountScoped(keys, `${where}'s runtimePermissions`);
    for (const key of keys) {
      if (!permissions.includes(key)) permissions.push(key);
    }
  }
  if (permissions.length === 0) return undefined;
  return {
    name: RUNTIME_PROFILE,
    permissions,
    secret: RUNTIME_TOKEN_SECRET,
    defaultStore: "secrets-store",
    description:
      "The one Cloudflare API token a deployed application holds: every composed capability's runtime needs, per environment. Analytics reads are account-wide by Cloudflare's grain.",
  };
}

/**
 * The project's token-profile registry: the aggregating `ci-system` profile and, when any composed
 * capability declares {@link Capability.runtimePermissions}, the aggregating `runtime` profile. Nothing
 * else — a capability cannot add a profile. This is the one registry `pithy token` reads.
 */
export function resolveTokenProfiles(capabilities: readonly Capability[]): Record<string, TokenProfile> {
  const runtime = runtimeProfile(capabilities);
  return {
    [CI_SYSTEM_PROFILE]: ciSystemProfile(capabilities),
    ...(runtime ? { [RUNTIME_PROFILE]: runtime } : {}),
  };
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

/**
 * Refuse a zone-scoped key anywhere a policy is being built **account-scoped**.
 *
 * A zone-level permission group handed the account resource is the quiet failure (#651): Cloudflare
 * mints the token without complaint and then answers "No access to the specified resource" at the call,
 * which is a CI failure hours later with nothing in it naming the scope. Which zones a token gets is
 * never a typed choice — it is the project's declared `domains`, resolved at mint time — so a key naming
 * one in a profile or behind `--permission` is a mistake, and this is where it is caught.
 */
function assertAccountScoped(keys: readonly string[], where: string): void {
  const zoneScoped = keys.filter(isZoneScopedPermission);
  if (zoneScoped.length === 0) return;
  throw new CloudflareNotConfiguredError({
    message: `${where} names zone-scoped permission(s): ${zoneScoped.join(", ")}.`,
    action:
      "A zone permission is not chosen by hand — declare the Worker's `domains` in pithy.config.ts and the mint scopes the token to those zones. Remove the key.",
    detail: `build token policy: ${zoneScoped.join(", ")} cannot take the account resource`,
  });
}

/** Build the account-scoped {@link TokenPermission}s for a set of permission keys — the mint input. */
export function permissionsForKeys(keys: PermissionKey[], accountId: string): TokenPermission[] {
  assertAccountScoped(keys, "This token");
  return [{ permissionGroupNames: resolvePermissionKeys(keys), resources: accountResource(accountId) }];
}

/**
 * The **zone-scoped** policy a project's declared domains require: Workers Routes Write on exactly those
 * zones, and nothing else.
 *
 * This is the second policy on the `ci-system` token, beside the account-scoped one every profile
 * builds. It exists because `pithy deploy` of an environment with a declared domain calls
 * `POST /zones/<zone>/workers/routes`, the one deploy step the CI credential could not make (#651) — and
 * it is a policy of its own rather than a permission on the profile because its resources are zones,
 * which a profile cannot name: they are resolved from the domains at mint time.
 *
 * **This limits the route, not the token.** The account policy beside it carries Workers Scripts Write,
 * which attaches a custom domain on any zone the account holds (measured, #709; `docs/TOKENS.md`). Only
 * the route calls are held to the declared zones.
 *
 * **Empty for an empty zone list, deliberately.** A project that declares no domain attaches no route,
 * so it mints exactly the token it minted before this existed. No new permission for a project that
 * needs none.
 */
export function routePermissions(zoneIds: readonly string[]): TokenPermission[] {
  if (zoneIds.length === 0) return [];
  return [{ permissionGroupNames: [...PERMISSION_GROUPS["routes:write"]], resources: zoneResources(zoneIds) }];
}

/**
 * Turn a resolved profile into the {@link TokenPermission}s the account-tokens manager mints from: the
 * profile's permission keys resolved to CF group names, scoped to the account (or the profile's
 * explicit resources). One policy per profile — a token carries exactly the access its profile declares.
 */
export function profilePermissions(profile: TokenProfile, accountId: string): TokenPermission[] {
  assertAccountScoped(profile.permissions, `Token profile "${profile.name}"`);
  const resources =
    profile.resources && profile.resources !== "account" ? profile.resources : accountResource(accountId);
  return [{ permissionGroupNames: resolvePermissionKeys(profile.permissions), resources }];
}
