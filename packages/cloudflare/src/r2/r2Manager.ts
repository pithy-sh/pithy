import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CloudflareNotConfiguredError, cloudflareRequest } from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";
import { R2Credentials } from "./r2Credentials";

/** How long a presigned R2 URL stays valid, in seconds (1 hour). */
const PRESIGN_EXPIRY_SECONDS = 3600;

/**
 * Config for the R2 manager: the shared client config plus the S3-compatible credential pair and
 * the bucket it targets. R2 signs presigned URLs with the S3 keys, not the CF API token — both
 * come from config (no environment coupling).
 */
export interface R2ManagerConfig extends CloudflareManagerConfig, R2Credentials {
  /** The R2 bucket all object operations target. */
  bucketName: string;
}

/**
 * Out-of-Worker Cloudflare R2 access: presigned S3 GET/PUT URLs for client-side up/download from a
 * CLI/CI/provisioning context. Inside a Worker you use the R2 binding directly; this manager is the
 * REST/S3 counterpart, addressed by bucket name.
 */
export class CloudflareR2Manager extends CloudflareManager {
  private readonly bucketName: string;

  private readonly accessKeyId: string;

  private readonly secretAccessKey: string;

  private s3Client: S3Client | null = null;

  constructor(config: R2ManagerConfig) {
    super(config);
    if (!config.bucketName) {
      throw new CloudflareNotConfiguredError({ detail: "Missing bucketName for R2 access." });
    }
    // Validate the S3 credential pair the same way every other manager guards its resource id —
    // an empty/unresolved key fails here with a clear config error, not later as an opaque SigV4 fault.
    const credentials = R2Credentials.safeParse(config);
    if (!credentials.success) {
      throw new CloudflareNotConfiguredError({
        detail: `Invalid R2 credentials: ${credentials.error.message}`,
      });
    }
    this.bucketName = config.bucketName;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
  }

  /** The S3-compatible client for R2, lazily created and cached for the manager's lifetime. */
  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
      });
    }
    return this.s3Client;
  }

  /** Presign a PUT URL for uploading one object. Valid for one hour. */
  async createUploadUrl(key: string, contentType: string, contentLength: number): Promise<string> {
    return cloudflareRequest(`R2 presign upload for '${key}'`, () => {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      });
      return getSignedUrl(this.getS3Client(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
    });
  }

  /** Presign a GET URL for downloading one object. Valid for one hour. */
  async createDownloadUrl(key: string): Promise<string> {
    return cloudflareRequest(`R2 presign download for '${key}'`, () => {
      const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      return getSignedUrl(this.getS3Client(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
    });
  }

  getServiceType(): string {
    return "Cloudflare R2";
  }

  /**
   * Prove access by reading the bucket record over the CF API (token + account + bucket existence),
   * not merely that an S3 client could be built. Never throws.
   */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().r2.buckets.get(this.bucketName, { account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }
}
