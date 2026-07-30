// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { r2CredentialsRegistry } from "@pithy-sh/storage/src/secret/registry";
import { z } from "zod";

/**
 * The secrets the media capability reads (CLAUDE.md §secrets). There are two, because they answer to
 * two different owners.
 *
 * `media-storage-credentials` is media's own: the scoped Cloudflare API token that mints Images and
 * Stream direct-upload URLs, and the account id it is scoped to. Nothing else.
 *
 * `media-r2-credentials` is **declared here and read nowhere in this package**. It is
 * `@pithy-sh/storage`'s R2 bundle, declared through that package's `r2CredentialsRegistry` factory and
 * resolved by the `ObjectStore` seam media presigns through. One factory means every declaration of
 * the name agrees on `backend`, `scope`, `rotatable`, and `valueType` — exactly what
 * `aggregateSecretRegistries` requires before it will let two capabilities share a name. So media
 * *names* the R2 secret and never handles an R2 key again.
 *
 * The values are **supplied, not minted**: Cloudflare exposes no API for creating an R2 S3 access-key
 * pair, and the permission catalog carries no Images or Stream keys, so the operator creates both and
 * hands them to `pithy media provision`. Pithy stores, scopes, and rotates them from there.
 */

/** The name the Images + Stream credentials are stored and resolved under. */
export const MEDIA_STORAGE_SECRET = "media-storage-credentials";

/** The name media's R2 bucket credentials are stored under — the name `objectStore` is pointed at. */
export const MEDIA_R2_SECRET = "media-r2-credentials";

/** The credential bundle media reads to mint Cloudflare Images and Stream direct-upload URLs. */
export const MediaStorageCredentials = z
  .object({
    apiToken: z
      .string()
      .describe("A scoped Cloudflare API token with Images and Stream permissions, for minting direct-upload URLs."),
    accountId: z.string().describe("The Cloudflare account id the media resources live in."),
  })
  .describe("The credentials the media capability reads to mint Cloudflare Images and Stream direct-upload URLs.");
export type MediaStorageCredentials = z.output<typeof MediaStorageCredentials>;

/**
 * The R2 half of media's registry — one entry, built by `@pithy-sh/storage`'s factory. Exported on its
 * own so the provisioner can write the secret against the *declared* schema rather than a second copy
 * of the shape, which is the only way the two cannot drift.
 */
export const mediaR2Registry = r2CredentialsRegistry(MEDIA_R2_SECRET);

/** The media capability's secret-registry slice — aggregated into the shared accessor at startup. */
export const mediaSecretsRegistry = defineSecretRegistry({
  [MEDIA_STORAGE_SECRET]: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: MediaStorageCredentials,
  },
  ...mediaR2Registry,
});
