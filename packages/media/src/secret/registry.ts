// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { runtimeTokenRegistry } from "@pithy-sh/secrets/src/tokens/runtimeTokenRegistry";
import { r2CredentialsRegistry } from "@pithy-sh/storage/src/secret/registry";
import { z } from "zod";
import type { MediaConfig } from "../config/config";

/**
 * The secrets the media capability reads (CLAUDE.md §secrets). Four are media's own or its object store's,
 * and the fifth is the application's.
 *
 * `media-storage-credentials` is media's own: the Cloudflare account id its Images and Stream assets live
 * in. **Nothing else** — the token that mints Images and Stream uploads was supplied here by hand until
 * #728, and is now the application's one `runtime` token.
 *
 * `media-r2-credentials` is **declared here and read nowhere in this package**. It is
 * `@pithy-sh/storage`'s R2 bundle, declared through that package's `r2CredentialsRegistry` factory and
 * resolved by the `ObjectStore` seam media presigns through. One factory means every declaration of
 * the name agrees on `backend`, `scope`, `rotatable`, and `valueType` — exactly what
 * `aggregateSecretRegistries` requires before it will let two capabilities share a name. So media
 * *names* the R2 secret and never handles an R2 key again. R2's S3 key pair is not a Cloudflare API token
 * in the sense the one-token rule means, and stays outside it: there is no API to mint one.
 *
 * `media-images-signing-key` and `media-stream-signing-key` are what a private record's bytes are
 * delivered through: a non-public Images or Stream asset is uploaded with `requireSignedURLs`, and the
 * Worker signs a short-lived URL for a caller who may read it (`deliver/sign.ts`). Both are **fetched by
 * `pithy media provision`** with the operator's own credential: Images keeps an account signing key, and
 * a Stream key's private half is handed back once, at creation.
 *
 * `RUNTIME_CF_API_TOKEN` is the application's one Cloudflare API token (#728), declared through
 * `@pithy-sh/secrets`' `runtimeTokenRegistry` so every reader declares it the same way. Media reads it to
 * mint Images and Stream uploads and to read their delivery analytics, and declares it only when its
 * config stores a type on one of them — see {@link mediaSecretsRegistryFor}.
 */

/** The name the Images + Stream credentials are stored and resolved under. */
export const MEDIA_STORAGE_SECRET = "media-storage-credentials";

/** Where the account id comes from, for an operator who would rather check it by hand. */
const MEDIA_ACCOUNT_PAGE = "https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/";

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

/**
 * The account media's Images and Stream assets live in — and, since #728, nothing else. A value written
 * before then also carries the `apiToken` an operator supplied; it is not read, the parse drops it, and
 * `pithy doctor` names it until `pithy media provision` rewrites the bundle without it.
 */
export const MediaStorageCredentials = z
  .object({
    accountId: z.string().meta({ multiline: false }).describe("The Cloudflare account id the media resources live in."),
  })
  .describe("The Cloudflare account media's Images and Stream assets live in.");
export type MediaStorageCredentials = z.output<typeof MediaStorageCredentials>;

/**
 * The field a `media-storage-credentials` bundle written before #728 also carries: the Images and Stream
 * token an operator supplied. Superseded by the runtime token, never read, and named by `pithy doctor` and
 * `pithy token list` until `pithy media provision` rewrites the bundle without it.
 */
export const MEDIA_SUPPLIED_TOKEN_FIELD = "apiToken";

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

/**
 * Media's own secrets and its object store's — what it declares whatever its config, and what every read
 * that is not the runtime token's goes through.
 */
export const mediaOwnSecretsRegistry = defineSecretRegistry({
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
    origin: { kind: "obtained", issuer: "cloudflare", documentation: MEDIA_ACCOUNT_PAGE },
    rotation: { kind: "manual", issuer: "cloudflare", documentation: MEDIA_ACCOUNT_PAGE },
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

/**
 * What media's Workers call Cloudflare with, from the resolved config (#728): `images:write` while images
 * live in Cloudflare Images, `stream:write` while video lives in Stream, and `analytics:read` while either
 * does, for the delivery read. Empty for a project storing both in R2, which calls Cloudflare for nothing
 * and adds nothing to the `runtime` token.
 */
export function mediaRuntimePermissions(config: Pick<MediaConfig, "images" | "video">): PermissionKey[] {
  const keys: PermissionKey[] = [];
  if (config.images.store === "cf-images") keys.push("images:write");
  if (config.video.store === "cf-stream") keys.push("stream:write");
  if (keys.length > 0) keys.push("analytics:read");
  return keys;
}

/**
 * The media capability's secret-registry slice for one resolved config — aggregated into the shared
 * accessor at startup. Media's own secrets always; the runtime token only when the config gives media a
 * reason to read it. A declared token is one `pithy provision` binds, so an R2-only project declaring it
 * would be asked for a grant nothing here uses.
 */
export function mediaSecretsRegistryFor(config: Pick<MediaConfig, "images" | "video">) {
  const needs = mediaRuntimePermissions(config);
  return needs.length === 0
    ? mediaOwnSecretsRegistry
    : defineSecretRegistry({ ...mediaOwnSecretsRegistry, ...runtimeTokenRegistry(needs) });
}

/**
 * The full slice — for a config with images in Cloudflare Images and video in Stream, the default. It is
 * what the prebuilt enrichment worker reads: one deploy serves every config, and it reads the runtime
 * token only for a video in Stream.
 */
export const mediaSecretsRegistry = defineSecretRegistry({
  ...mediaOwnSecretsRegistry,
  ...runtimeTokenRegistry(["images:write", "stream:write", "analytics:read"]),
});
