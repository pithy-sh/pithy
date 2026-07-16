import type { R2Bucket } from "@cloudflare/workers-types";
import { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { MediaConfig } from "../config/config";
import { MEDIA_STORAGE_SECRET, mediaSecretsRegistry } from "../secret/registry";
import { imageMinter, r2Minter, videoMinter } from "./cloudflare";
import { type MediaStorage, mediaStorage } from "./storage";

/** The env the storage layer reads: the secrets bindings plus the `MEDIA_BUCKET` R2 binding. */
export type StorageEnv = SecretsStoreEnv & {
  /** The R2 bucket binding media objects are read from and deleted through (bindings-first). */
  MEDIA_BUCKET: R2Bucket;
};

/**
 * Resolve the storage seam from the request env. The scoped CF API token and R2 credentials are read once
 * through the shared `@pithy-sh/secrets` accessor (never a raw binding), and the CF managers are built
 * from them; the R2 bucket binding comes straight off the env. Every direct-upload URL is minted through
 * `@pithy-sh/cloudflare`.
 */
export async function resolveStorage(env: StorageEnv, config: MediaConfig): Promise<MediaStorage> {
  const store = await sharedSecretsStore(env, mediaSecretsRegistry);
  const credentials = store.get(MEDIA_STORAGE_SECRET);
  const clientConfig = { apiToken: credentials.apiToken, accountId: credentials.accountId };
  return mediaStorage({
    image: imageMinter(new CloudflareImageManager(clientConfig)),
    video: videoMinter(new CloudflareStreamManager(clientConfig)),
    r2: r2Minter(
      new CloudflareR2Manager({
        ...clientConfig,
        accessKeyId: credentials.r2AccessKeyId,
        secretAccessKey: credentials.r2SecretAccessKey,
        bucketName: credentials.r2BucketName,
      }),
    ),
    bucket: env.MEDIA_BUCKET,
    config,
  });
}
