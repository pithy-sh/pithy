// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineSecretRegistry } from "../registry";

/**
 * The secrets-manager worker's own secret registry. The manager reads it the seam's standard way —
 * `sharedSecretsStore(env, managerRegistry)`, then `.get("CLOUDFLARE_API_TOKEN")` at the point of need, so
 * every secret use is a visible, grep-able call site. The token is read as a `cf-secrets-store`
 * binding, never a plaintext env string.
 *
 * `CLOUDFLARE_API_TOKEN` is `global` (one value, written once canonically via prod, bound the
 * same way by every manager) and `rotatable` (forward-looking — a future value-rotator may self-roll
 * it; no value-rotation logic ships now). Provisioning owns the store-entry-name → binding-var
 * mapping out of band: the entry lives in the account's one flat Secrets Store under the
 * project-scoped name `<project>-global-secrets-manager-cf-api-token` (`managerCfApiTokenSecretName`)
 * and binds into each manager as `CLOUDFLARE_API_TOKEN`, so this registry stays keyed by the binding
 * var — which is not scoped, and must not be (see `provision/provisionSecrets`).
 *
 * **Least privilege — this token needs Secrets Store edit access and nothing else.** The manager's
 * only runtime use of the token is the at-rest rotation's config write-back (`CloudflareSecretsStoreManager.putSecret`
 * → list + delete + create on the store). The rotation's D1 re-encryption runs entirely through the
 * `SECRETS` binding, so the token grants no D1 or Workers access. Scope it to **Account › Secrets
 * Store › Edit** on the one store. (It is distinct from the broad bootstrap token the CLI uses to
 * deploy and provision — see `provision/provisionSecrets` for that boundary.)
 */
export const managerRegistry = defineSecretRegistry({
  CLOUDFLARE_API_TOKEN: {
    backend: "cf-secrets-store",
    scope: "global",
    rotatable: true,
    valueType: "text",
    // `helped` to create, `provider` to rotate — the case a single axis cannot express, and the reason
    // #322 has two. We cannot mint a Cloudflare token: that needs credentials for their account, which
    // this product must never hold. We can say exactly what one needs, so nothing downstream keeps its
    // own table of permission groups — `needs.cloudflare` is `secretsTokenProfile.permissions`, and
    // `capability.test.ts` holds the two to each other rather than trusting this copy.
    origin: {
      kind: "helped",
      issuer: "cloudflare",
      needs: { cloudflare: ["secrets:read", "secrets:write"] },
      documentation: "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/",
    },
    // Cloudflare rolls a token and returns the new value, so this one can replace itself. Declared per
    // secret and never per issuer: some Cloudflare secrets roll and some do not, and `issuer` says
    // nothing about which.
    rotation: {
      kind: "provider",
      issuer: "cloudflare",
      documentation: "https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/",
    },
  },
});
