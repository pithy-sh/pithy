import { defineSecretRegistry } from "../registry";

/**
 * The secrets-manager worker's own secret registry. The manager reads it the seam's standard way —
 * `secretsStore(env, managerRegistry)`, then `.get("CLOUDFLARE_API_TOKEN")` at the point of need, so
 * every secret use is a visible, grep-able call site. The token is read as a `cf-secrets-store`
 * binding, never a plaintext env string.
 *
 * `CLOUDFLARE_API_TOKEN` is `global` (one value, written once canonically via production, bound the
 * same way by every manager) and `rotatable` (forward-looking — a future value-rotator may self-roll
 * it; no value-rotation logic ships now). Provisioning owns the store-entry-name → binding-var
 * mapping out of band: the entry lives in the Secrets Store as `GLOBAL_SECRETS_MANAGER_CF_API_TOKEN`
 * and binds into each manager as `CLOUDFLARE_API_TOKEN`, so this registry stays keyed by the binding
 * var (see `provision/provisionSecrets`).
 *
 * **Least privilege — this token needs Secrets Store edit access and nothing else.** The manager's
 * only runtime use of the token is the at-rest rotation's config write-back (`CloudflareSecretsStoreManager.putSecret`
 * → list + delete + create on the store). The rotation's D1 re-encryption runs entirely through the
 * `SECRETS` binding, so the token grants no D1 or Workers access. Scope it to **Account › Secrets
 * Store › Edit** on the one store. (It is distinct from the broad bootstrap token the CLI uses to
 * deploy and provision — see `provision/provisionSecrets` for that boundary.)
 */
export const managerRegistry = defineSecretRegistry({
  CLOUDFLARE_API_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
});
