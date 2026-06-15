import type { RequestOptions } from "cloudflare/core";
import type { Image, V1CreateParams, V1EditParams } from "cloudflare/resources/images/v1/v1";
import type {
  DirectUploadCreateParams,
  DirectUploadCreateResponse,
} from "cloudflare/resources/images/v2/direct-uploads";
import type { V2ListParams } from "cloudflare/resources/images/v2/v2";
import { cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Per-request CF SDK options for every Images call: a 10s timeout and up to 3 retries. Uploads and
 * list calls can be slow, so the timeout is generous and retries cover transient API blips.
 */
const requestOptions: RequestOptions = {
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

/**
 * Out-of-Worker Cloudflare Images access over the REST API: upload, fetch, edit, delete, list, and
 * direct-upload URLs from a CLI/CI/provisioning context. Image metadata is an arbitrary
 * `Record<string, string>` passthrough — no Pithy-specific shape is imposed on it.
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
