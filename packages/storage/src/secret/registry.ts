// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import type { SecretOrigin, SecretRotation } from "@pithy-sh/core/src/capability/secretOrigin";
import { defineSecretRegistry, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { z } from "zod";

/**
 * The R2 credential bundle the {@link ObjectStore} seam reads, and the **factory** that declares it
 * under any name (CLAUDE.md §Secrets).
 *
 * Why a factory and not a bare name. `sharedSecretsStore(env, registry)` throws for any name absent
 * from the *aggregated* registry, and that registry is built only from the composed capabilities'
 * `secretRegistry` slices. So `objectStore({ bucket, secretName })` cannot resolve a string on its
 * own — something must have declared that name, with a schema, on a capability. The factory is that
 * something: storage declares `storage-r2-credentials` for `STORAGE_BUCKET`, `@pithy-sh/media`
 * declares `media-r2-credentials` for `MEDIA_BUCKET`, and both point the same seam at their own
 * bucket without either package knowing the other's name.
 *
 * One factory is also what makes the join key safe. `aggregateSecretRegistries` allows a name to be
 * declared twice only when every axis agrees (`backend`, `scope`, `valueType`, `rotatable`); two
 * hand-written declarations drift, one factory cannot.
 */

/**
 * The credentials one R2 bucket is addressed and presigned with. Composed from
 * {@link R2Credentials} rather than redeclaring the key pair — that shape is `@pithy-sh/cloudflare`'s
 * to define, and `CloudflareR2Manager` validates its config against it.
 */
export const R2StorageCredentials = R2Credentials.extend({
  accountId: z.string().min(1).describe("The Cloudflare account id the bucket lives in — the S3 endpoint host."),
  bucket: z.string().min(1).describe("The R2 bucket name every presigned URL and server-side object call targets."),
  apiToken: z
    .string()
    .min(1)
    .describe(
      "The R2-scoped Cloudflare API token the key pair was derived from. Carried alongside because an R2 S3 access key IS a CF API token — the id is the key id, the SHA-256 of the value is the secret — so whatever provisions the pair already holds it, and `CloudflareR2Manager` needs it to prove bucket access.",
    ),
}).describe("The account, key pair, scoped token, and bucket name the object store presigns and addresses R2 with.");
export type R2StorageCredentials = z.output<typeof R2StorageCredentials>;

/**
 * One R2-credentials registry entry. Spelled out as a type so the factory can return
 * `Record<N, R2CredentialsEntry>` — a computed key alone widens to a string index signature, which
 * would lose the literal name `SecretsAccessor.get` narrows on.
 */
export interface R2CredentialsEntry {
  /**
   * An encrypted row in the per-environment secrets D1 — where these values actually live.
   *
   * No `wrangler.jsonc` binds an R2 credential bundle from the Cloudflare Secrets Store; `pithy storage
   * provision` and `pithy media provision` write it through `dispatchSecretWrite` → the manager
   * Workflow → `SystemSecretsStore`, which is the D1 path. The registry's `backend` is the *single*
   * place a secret's storage location is decided and is what the read seam routes on, so declaring
   * `cf-secrets-store` here would send every deployed read to a binding that does not exist.
   */
  backend: "d1";
  /** Each environment addresses its own bucket with its own key pair. */
  scope: "environment";
  /** R2 S3 key pairs are minted and replaced whole, not rotated with overlap windows. */
  rotatable: false;
  /** A JSON bundle, validated against {@link R2StorageCredentials} before it is exposed. */
  valueType: "json";
  /** The bundle's shape. */
  schema: typeof R2StorageCredentials;
  /** Where the pair comes from. `obtained`, always — see {@link R2_CREDENTIALS_PAGE}. */
  origin: SecretOrigin;
  /** How the pair is replaced. `manual`, always — the same page, by the same human. */
  rotation: SecretRotation;
}

/**
 * Where a human makes an R2 S3 access-key pair, and where the same human makes the next one.
 *
 * **Nothing here will ever mint one, and that is the fact the declaration carries.** Cloudflare has no
 * API that returns an S3 access-key pair, so `pithy storage provision` and `pithy media provision` both
 * take one as a flag and write it as given — a generated value would open no bucket and would replace a
 * loud gap with a quiet one. Naming the page is the whole of the help the kit can offer, which is exactly
 * what `obtained` is for.
 *
 * Origin and rotation name the same page because it is the same page: replacement is making another pair
 * and deleting the old one. That is also why {@link R2CredentialsEntry.rotatable} is false — there is no
 * overlap window to hold two live versions through.
 */
const R2_CREDENTIALS_PAGE = "https://developers.cloudflare.com/r2/api/tokens/";

/**
 * The one entry shape every name shares — declared once so no two declarations can disagree.
 *
 * The two declaration axes live here rather than at each name for the reason the rest of the entry does:
 * `storage-r2-credentials` and `media-r2-credentials` are the same kind of credential from the same
 * issuer, and `aggregateSecretRegistries` refuses a name two capabilities describe differently. One
 * factory is how they cannot.
 */
const R2_CREDENTIALS_ENTRY: R2CredentialsEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "json",
  schema: R2StorageCredentials,
  origin: { kind: "obtained", issuer: "cloudflare", documentation: R2_CREDENTIALS_PAGE },
  rotation: { kind: "manual", issuer: "cloudflare", documentation: R2_CREDENTIALS_PAGE },
};

/**
 * A one-entry secret-registry slice declaring `name` as an R2 credential bundle. Hang it on the
 * declaring capability's `secretRegistry`, then pass the same `name` to `objectStore`.
 */
export function r2CredentialsRegistry<const N extends string>(name: N): Record<N, R2CredentialsEntry> {
  return defineSecretRegistry({ [name]: R2_CREDENTIALS_ENTRY } as Record<N, R2CredentialsEntry> & SecretRegistry);
}

/** The name storage's own bucket credentials are stored and resolved under. */
export const STORAGE_R2_SECRET = "storage-r2-credentials";

/** The storage capability's secret-registry slice — aggregated into the shared accessor at startup. */
export const storageSecretsRegistry = r2CredentialsRegistry(STORAGE_R2_SECRET);
