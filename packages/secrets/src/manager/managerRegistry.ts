// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineSecretRegistry } from "../registry";
import { runtimeTokenRegistry } from "../tokens/runtimeTokenRegistry";

/**
 * What the secrets manager's Worker calls Cloudflare with: Secrets Store read and write, nothing else
 * (#728). Its one live-Cloudflare write is the at-rest rotation's write-back of the new key set; the D1
 * re-encryption runs through the `SECRETS` binding.
 *
 * The capability declares it as `runtimePermissions`, so it unions into the one `runtime` token the
 * application holds, beside every other capability's. The manager has no token of its own, and the profile
 * it once had — `secrets`, minted into `SECRETS_MANAGER_CF_API_TOKEN` — is superseded by `runtime`. Stated
 * here rather than on the capability, so the manager's bundle reads it without importing the capability.
 */
export const SECRETS_RUNTIME_PERMISSIONS = ["secrets:read", "secrets:write"] as const;

/**
 * The secrets-manager worker's own secret registry. The manager reads it the seam's standard way —
 * `sharedSecretsStore(env, managerRegistry)`, then `.get(RUNTIME_TOKEN_SECRET)` at the point of need, so
 * every secret use is a visible, grep-able call site. The token is read as a `cf-secrets-store` binding,
 * never a plaintext env string.
 *
 * **It is the application's one `runtime` token (#728)**, the same value every other Worker of this
 * environment that calls Cloudflare reads. Per environment: each manager binds its own environment's entry,
 * `<project>-<env>-runtime-cf-api-token`, so revoking staging's token leaves production rotating.
 * Provisioning owns the entry-name → binding mapping out of band (`provision/resolveManagerConfig`), so
 * this registry stays keyed by the binding, which is not scoped and must not be.
 *
 * **What the manager needs of it is Secrets Store read and write, and nothing else.** Its only runtime use
 * is the at-rest rotation's config write-back (`CloudflareSecretsStoreManager.putSecret` → list + delete +
 * create on the store). The rotation's D1 re-encryption runs entirely through the `SECRETS` binding.
 */
export const managerRegistry = defineSecretRegistry({
  ...runtimeTokenRegistry(SECRETS_RUNTIME_PERMISSIONS),
});
