// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { r2CredentialsRegistry } from "@pithy-sh/storage/src/secret/registry";
import { z } from "zod";

/**
 * The secrets the media capability reads (CLAUDE.md §secrets). There are four, and they answer to two
 * different owners.
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
 * `media-images-signing-key` and `media-stream-signing-key` are what a private record's bytes are
 * delivered through: a non-public Images or Stream asset is uploaded with `requireSignedURLs`, and the
 * Worker signs a short-lived URL for a caller who may read it (`deliver/sign.ts`). Both are **fetched by
 * `pithy media provision`** with the Images and Stream token: Images keeps an account signing key, and a
 * Stream key's private half is handed back once, at creation.
 *
 * The credentials are **supplied, not minted**: Cloudflare exposes no API for creating an R2 S3
 * access-key pair, and the permission catalog carries no Images or Stream keys, so the operator creates
 * both and hands them to `pithy media provision`. Pithy stores, scopes, and rotates them from there.
 */

/** The name the Images + Stream credentials are stored and resolved under. */
export const MEDIA_STORAGE_SECRET = "media-storage-credentials";

/**
 * Where a human makes the scoped Images + Stream token, and where Cloudflare rolls it.
 *
 * **Two pages, because the two axes genuinely differ here.** The kit cannot compose the creation command:
 * `pithy token mint` works from a permission catalog, and that catalog carries no Images or Stream group,
 * so an operator picks them in the dashboard. Replacement is not the same act — a Cloudflare API token
 * rolls through Cloudflare's own API and comes back with its successor, which is what `provider` means
 * and what the manager's own token already declares.
 *
 * This is the pair `media-r2-credentials` does *not* have, and the reason rotation is declared per secret
 * rather than per issuer: both come from Cloudflare, and only one of them can replace itself.
 */
const MEDIA_TOKEN_PAGE = "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/";
const MEDIA_TOKEN_ROLL = "https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/";

/** The name the Cloudflare Images URL-signing key is stored under. */
export const MEDIA_IMAGES_SIGNING_SECRET = "media-images-signing-key";

/** The name the Cloudflare Stream signing key is stored under. */
export const MEDIA_STREAM_SIGNING_SECRET = "media-stream-signing-key";

/** Where Cloudflare documents signed delivery for each product — and where each key is rolled. */
const IMAGES_SIGNING_PAGE = "https://developers.cloudflare.com/images/manage-images/serve-images/serve-private-images/";
const STREAM_SIGNING_PAGE = "https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/";

/** The name media's R2 bucket credentials are stored under — the name `objectStore` is pointed at. */
export const MEDIA_R2_SECRET = "media-r2-credentials";

/**
 * The bucket binding those credentials presign, declared beside the name so the two travel together.
 *
 * `media()` declares the same string as a required R2 binding. It is stated here rather than imported
 * from the capability because the capability imports this module, and a credential that names the
 * binding it exists to reach is what stops `pithy doctor` asking for a bundle whose bucket a project
 * has declined (#541).
 */
export const MEDIA_BUCKET_BINDING = "MEDIA_BUCKET";

/** The credential bundle media reads to mint Cloudflare Images and Stream direct-upload URLs. */
export const MediaStorageCredentials = z
  .object({
    apiToken: z
      .string()
      .meta({ multiline: false })
      .describe("A scoped Cloudflare API token with Images and Stream permissions, for minting direct-upload URLs."),
    accountId: z.string().meta({ multiline: false }).describe("The Cloudflare account id the media resources live in."),
  })
  .describe("The credentials the media capability reads to mint Cloudflare Images and Stream direct-upload URLs.");
export type MediaStorageCredentials = z.output<typeof MediaStorageCredentials>;

/** The Images URL-signing key, as `pithy media provision` reads it off the account. */
export const MediaImagesSigningKey = z
  .object({
    key: z
      .string()
      .min(1)
      .meta({ multiline: false })
      .describe(
        "The Cloudflare Images URL-signing key — the HMAC secret a private image's delivery URL is signed with.",
      ),
  })
  .describe("The key media signs private Cloudflare Images delivery URLs with.");
export type MediaImagesSigningKey = z.output<typeof MediaImagesSigningKey>;

/** A Stream signing key, as `pithy media provision` creates it. */
export const MediaStreamSigningKey = z
  .object({
    keyId: z
      .string()
      .min(1)
      .meta({ multiline: false })
      .describe("The Stream signing key's id — the `kid` every signed playback token names."),
    jwk: z
      .string()
      .min(1)
      .meta({ multiline: false })
      .describe("The key's private half, as the base64-encoded JWK Cloudflare returns once, at creation."),
  })
  .describe("The key media signs private Cloudflare Stream playback tokens with.");
export type MediaStreamSigningKey = z.output<typeof MediaStreamSigningKey>;

/**
 * The R2 half of media's registry — one entry, built by `@pithy-sh/storage`'s factory. Exported on its
 * own so the provisioner can write the secret against the *declared* schema rather than a second copy
 * of the shape, which is the only way the two cannot drift.
 */
export const mediaR2Registry = r2CredentialsRegistry(MEDIA_R2_SECRET, MEDIA_BUCKET_BINDING);

/** The media capability's secret-registry slice — aggregated into the shared accessor at startup. */
export const mediaSecretsRegistry = defineSecretRegistry({
  [MEDIA_STORAGE_SECRET]: {
    // An encrypted row in the per-environment secrets D1 — where this value actually lives. No
    // wrangler template binds it from the Cloudflare Secrets Store; `pithy media provision` writes it
    // through `dispatchSecretWrite` → the manager Workflow → `SystemSecretsStore`, the D1 path. The
    // read seam routes strictly on this field, so it has to say where the value really is.
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: MediaStorageCredentials,
    origin: { kind: "obtained", issuer: "cloudflare", documentation: MEDIA_TOKEN_PAGE },
    rotation: { kind: "provider", issuer: "cloudflare", documentation: MEDIA_TOKEN_ROLL },
  },
  [MEDIA_IMAGES_SIGNING_SECRET]: {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: MediaImagesSigningKey,
    origin: { kind: "obtained", issuer: "cloudflare", documentation: IMAGES_SIGNING_PAGE },
    rotation: { kind: "provider", issuer: "cloudflare", documentation: IMAGES_SIGNING_PAGE },
  },
  [MEDIA_STREAM_SIGNING_SECRET]: {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: MediaStreamSigningKey,
    origin: { kind: "obtained", issuer: "cloudflare", documentation: STREAM_SIGNING_PAGE },
    rotation: { kind: "provider", issuer: "cloudflare", documentation: STREAM_SIGNING_PAGE },
  },
  // Both axes arrive with the entry, from `@pithy-sh/storage`'s factory. Restating them here is how the
  // two declarations of one name would drift, and `aggregateSecretRegistries` is what would then refuse
  // to boot a Worker composing both capabilities.
  ...mediaR2Registry,
});
