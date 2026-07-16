import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { z } from "zod";

/**
 * The secrets the media capability reads (CLAUDE.md §secrets). Minting a direct-upload URL inside the
 * Worker needs a scoped CF API token (Images + Stream) and the R2 S3 credential pair — never a raw
 * `env.X` binding. `pithy media provision` mints the scoped token and R2 keys and writes this one secret;
 * every read site resolves it through the `secretsStore` reader.
 */

/** The name the storage-credentials secret is stored and resolved under. */
export const MEDIA_STORAGE_SECRET = "media-storage-credentials";

/** The credential bundle the storage layer reads to mint direct-upload URLs and address R2. */
export const MediaStorageCredentials = z
  .object({
    apiToken: z
      .string()
      .describe("A scoped Cloudflare API token with Images and Stream permissions, for minting direct-upload URLs."),
    accountId: z.string().describe("The Cloudflare account id the media resources live in."),
    r2AccessKeyId: z.string().describe("The R2 S3-compatible access key id used to presign R2 uploads."),
    r2SecretAccessKey: z.string().describe("The R2 S3-compatible secret access key used to presign R2 uploads."),
    r2BucketName: z.string().describe("The R2 bucket media objects are stored in."),
  })
  .describe("The credentials the media capability reads to mint direct-upload URLs and address R2.");
export type MediaStorageCredentials = z.output<typeof MediaStorageCredentials>;

/** The media capability's secret-registry slice — aggregated into the shared accessor at startup. */
export const mediaSecretsRegistry = defineSecretRegistry({
  [MEDIA_STORAGE_SECRET]: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: MediaStorageCredentials,
  },
});
