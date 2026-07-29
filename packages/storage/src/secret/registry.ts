import { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
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
  /** Native Cloudflare Secrets Store: the value is a bound secret, never a D1 row. */
  backend: "cf-secrets-store";
  /** Each environment addresses its own bucket with its own key pair. */
  scope: "environment";
  /** R2 S3 key pairs are minted and replaced whole, not rotated with overlap windows. */
  rotatable: false;
  /** A JSON bundle, validated against {@link R2StorageCredentials} before it is exposed. */
  valueType: "json";
  /** The bundle's shape. */
  schema: typeof R2StorageCredentials;
}

/** The one entry shape every name shares — declared once so no two declarations can disagree. */
const R2_CREDENTIALS_ENTRY: R2CredentialsEntry = {
  backend: "cf-secrets-store",
  scope: "environment",
  rotatable: false,
  valueType: "json",
  schema: R2StorageCredentials,
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
