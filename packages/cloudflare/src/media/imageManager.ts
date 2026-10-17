// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Cloudflare } from "cloudflare";
import type { Image, V1CreateParams, V1EditParams } from "cloudflare/resources/images/v1/v1";
import type {
  DirectUploadCreateParams,
  DirectUploadCreateResponse,
} from "cloudflare/resources/images/v2/direct-uploads";
import type { V2ListParams } from "cloudflare/resources/images/v2/v2";
import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Per-request CF SDK options for every Images call: a 10s timeout and up to 3 retries. Uploads and
 * list calls can be slow, so the timeout is generous and retries cover transient API blips.
 */
const requestOptions: Cloudflare.RequestOptions = {
  timeout: 10000,
  maxRetries: 3,
};

/**
 * Encode a user-metadata bag to the string the Images API expects. CF stores image metadata as a
 * JSON string; we serialize the generic `Record<string, string>` passthrough before sending, and
 * leave an absent bag untouched.
 */
function encodeMetadata(metadata: unknown): unknown {
  return metadata === undefined || metadata === null ? metadata : JSON.stringify(metadata);
}

/** One of the account's Images URL-signing keys. The value is the HMAC secret signed URLs are minted with. */
export const ImagesSigningKey = z
  .object({
    name: z.string().min(1).describe("The key's name. Cloudflare provisions one named `default`."),
    value: z.string().min(1).describe("The key itself — the HMAC-SHA256 secret a signed delivery URL is minted with."),
  })
  .describe("One Cloudflare Images URL-signing key.");
export type ImagesSigningKey = z.infer<typeof ImagesSigningKey>;

const SigningKeysResponse = z
  .object({ keys: z.array(ImagesSigningKey).optional().describe("The account's signing keys.") })
  .describe("The Images signing-keys response.");

/** One Images variant, and whether it serves an image without a signature whatever the image requires. */
export const ImagesVariant = z
  .object({
    id: z.string().describe("The variant's name, as it appears in a delivery URL."),
    neverRequireSignedURLs: z
      .boolean()
      .describe("Whether this variant serves every image unsigned, even one uploaded with requireSignedURLs."),
  })
  .describe("One Cloudflare Images variant's signing posture.");
export type ImagesVariant = z.infer<typeof ImagesVariant>;

const VariantsResponse = z
  .object({
    variants: z
      .record(
        z.string(),
        z
          .object({
            id: z.string().describe("The variant name."),
            neverRequireSignedURLs: z.boolean().optional().describe("Whether it ignores signing."),
          })
          .describe("One variant as the API returns it."),
      )
      .optional()
      .describe("Every variant, keyed by name."),
  })
  .describe("The Images variants response.");

/** Parse an Images response the SDK types loosely, refusing a shape we cannot read. */
function parseResponse<T>(schema: z.ZodType<T>, response: unknown, what: string): T {
  const result = schema.safeParse(response);
  if (!result.success) {
    throw new CloudflareInvalidResponseError({
      message: `An Images ${what} response had an unexpected shape.`,
      detail: result.error.message,
    });
  }
  return result.data;
}

/**
 * Out-of-Worker Cloudflare Images access over the REST API: upload, fetch, edit, delete, list, and
 * direct-upload URLs from a CLI/CI/provisioning context. Image metadata is an arbitrary
 * `Record<string, string>` passthrough at this layer — the manager imposes no shape.
 *
 * The ownership stamp is imposed one layer up, by `withAssetOwnership` in `ownership.ts`, which every
 * Pithy path that *creates* an image goes through (the seeder here, and media's `imageMinter`). The
 * split is deliberate: this class stays a faithful REST client usable for reading and sweeping
 * anyone's images, while nothing Pithy writes can escape carrying `pithyProject`/`pithyEnv`.
 */
export class CloudflareImageManager extends CloudflareManager {
  /** Upload an image via the V1 API. `account_id` is set from the manager's config. */
  async uploadImage(params: Omit<V1CreateParams, "account_id">): Promise<Image> {
    return cloudflareRequest("Images upload", () =>
      this.getClient().images.v1.create(
        { account_id: this.accountId, ...params, metadata: encodeMetadata(params.metadata) },
        requestOptions,
      ),
    );
  }

  /** Fetch details for one image by id. */
  async imageDetails(imageId: string): Promise<Image> {
    return cloudflareRequest(`Images get details for '${imageId}'`, () =>
      this.getClient().images.v1.get(imageId, { account_id: this.accountId }, requestOptions),
    );
  }

  /** Update an image's metadata and settings. */
  async updateImage(imageId: string, params: Omit<V1EditParams, "account_id">): Promise<Image> {
    return cloudflareRequest(`Images update '${imageId}'`, () =>
      this.getClient().images.v1.edit(imageId, { account_id: this.accountId, ...params }, requestOptions),
    );
  }

  /** Delete an image by id. */
  async deleteImage(imageId: string): Promise<void> {
    await cloudflareRequest(`Images delete '${imageId}'`, () =>
      this.getClient().images.v1.delete(imageId, { account_id: this.accountId }, requestOptions),
    );
  }

  /** Create a direct-upload URL for a client-side upload (V2 API). */
  async createDirectUploadUrl(
    params: Omit<DirectUploadCreateParams, "account_id">,
  ): Promise<DirectUploadCreateResponse> {
    return cloudflareRequest("Images create direct upload URL", () =>
      this.getClient().images.v2.directUploads.create(
        { account_id: this.accountId, ...params, metadata: encodeMetadata(params.metadata) },
        requestOptions,
      ),
    );
  }

  /** List images (V2 API), first page only. Returns the page's images, never null. */
  async listImages(params?: Omit<V2ListParams, "account_id">): Promise<Image[]> {
    return cloudflareRequest("Images list", async () => {
      const response = await this.getClient().images.v2.list({ account_id: this.accountId, ...params }, requestOptions);
      return response.images ?? [];
    });
  }

  /** List all images across every page, following the V2 continuation token. */
  async listAllImages(params?: Omit<V2ListParams, "account_id">): Promise<Image[]> {
    return cloudflareRequest("Images list all", async () => {
      const allImages: Image[] = [];
      const client = this.getClient();
      const fetchPage = async (token?: string | null): Promise<void> => {
        const response = await client.images.v2.list(
          { account_id: this.accountId, ...params, continuation_token: token },
          requestOptions,
        );
        if (response.images) allImages.push(...response.images);
        if (response.continuation_token) await fetchPage(response.continuation_token);
      };
      await fetchPage();
      return allImages;
    });
  }

  /**
   * The account's URL-signing keys — what a signed delivery URL for an image uploaded with
   * `requireSignedURLs` is minted with. Cloudflare provisions a `default` key per account.
   */
  async signingKeys(): Promise<ImagesSigningKey[]> {
    return cloudflareRequest("Images list signing keys", async () => {
      const response = await this.getClient().images.v1.keys.list({ account_id: this.accountId }, requestOptions);
      return parseResponse(SigningKeysResponse, response, "signing keys").keys ?? [];
    });
  }

  /** Create a named signing key, or roll it if it exists. Answers with every key the account then holds. */
  async createSigningKey(name: string): Promise<ImagesSigningKey[]> {
    return cloudflareRequest(`Images create signing key '${name}'`, async () => {
      const response = await this.getClient().images.v1.keys.update(
        name,
        { account_id: this.accountId },
        requestOptions,
      );
      return parseResponse(SigningKeysResponse, response, "signing keys").keys ?? [];
    });
  }

  /**
   * Every variant, with whether it serves unsigned. A variant set to `neverRequireSignedURLs` delivers a
   * private image to anyone holding its URL, which is why media's provisioning reads this.
   */
  async listVariants(): Promise<ImagesVariant[]> {
    return cloudflareRequest("Images list variants", async () => {
      const response = await this.getClient().images.v1.variants.list({ account_id: this.accountId }, requestOptions);
      const variants = parseResponse(VariantsResponse, response, "variants").variants ?? {};
      return Object.values(variants).map((variant) => ({
        id: variant.id,
        neverRequireSignedURLs: variant.neverRequireSignedURLs === true,
      }));
    });
  }

  getServiceType(): string {
    return "Cloudflare Images";
  }

  /** Prove access by listing images. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.listImages();
      return true;
    } catch {
      return false;
    }
  }
}
