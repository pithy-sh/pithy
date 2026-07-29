import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { CloudflareNotConfiguredError, cloudflareRequest, decodeResponse } from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";
import { R2Credentials } from "./r2Credentials";

/** How long a presigned R2 URL stays valid, in seconds (1 hour), when the caller names no lifetime. */
const PRESIGN_EXPIRY_SECONDS = 3600;

/** How many parts one `ListParts` page returns. S3's own cap; the drain loop below relies on it. */
const LIST_PARTS_PAGE_SIZE = 1000;

/**
 * Config for the R2 manager: the shared client config plus the S3-compatible credential pair and
 * the bucket it targets. R2 signs presigned URLs with the S3 keys, not the CF API token — both
 * come from config (no environment coupling).
 */
export interface R2ManagerConfig extends CloudflareManagerConfig, R2Credentials {
  /** The R2 bucket all object operations target. */
  bucketName: string;
}

/** How long a presigned URL stays valid. Shared by every presign method so the option reads the same. */
export interface PresignOptions {
  /** Lifetime in seconds. Defaults to one hour — long enough for a large upload, short enough to leak little. */
  expiresIn?: number;
}

/** Presign options for one multipart part, which may additionally pin the part's exact byte count. */
export interface PresignPartOptions extends PresignOptions {
  /**
   * Exact byte count the client must send. Omitted by default — see {@link CloudflareR2Manager.presignUploadPart}
   * for why signing a part length is opt-in where signing a whole-object length is not.
   */
  contentLength?: number;
}

/** What emptying a bucket reclaimed — the counts a teardown reports and an audit event records. */
export interface R2BucketDrain {
  /** How many stored objects were deleted. */
  objectsDeleted: number;
  /** How many abandoned multipart uploads were aborted before the objects were drained. */
  uploadsAborted: number;
}

/** Which slice of a bucket's keys to list, and how many to return. */
export interface ListObjectsOptions {
  /** Only return keys starting with this prefix. Omitted lists the whole bucket. */
  prefix?: string;
  /** Continuation cursor from a previous page's `cursor`. Omitted starts at the beginning. */
  cursor?: string;
  /** Page size. R2 caps this at 1000 and returns a `cursor` when more remain. */
  maxKeys?: number;
}

/** One completed part, as the client reports it back after a presigned `PUT` to a part URL. */
export interface CompletedPart {
  /** The part's 1-based index, matching the `partNumber` the part URL was presigned for. */
  partNumber: number;
  /** The `ETag` response header R2 returned for that part, verbatim — quotes included. */
  etag: string;
}

/** An object's metadata as R2 reports it, without fetching the body. */
export const R2ObjectHead = z
  .object({
    size: z.number().int().nonnegative().describe("The object's size in bytes."),
    etag: z.string().min(1).describe("R2's entity tag for this object version, verbatim — quotes included."),
    contentType: z
      .string()
      .min(1)
      .optional()
      .describe("The stored `Content-Type`. Absent when the object was written without one."),
    uploaded: z.date().optional().describe("When R2 last wrote the object. Absent when R2 reports no timestamp."),
  })
  .describe("Metadata for one R2 object, read with a HEAD — no body transfer.");
export type R2ObjectHead = z.output<typeof R2ObjectHead>;

/** One part already uploaded against an in-flight multipart upload. */
export const R2UploadedPart = z
  .object({
    partNumber: z.number().int().min(1).describe("The part's 1-based index within the upload."),
    etag: z.string().min(1).describe("The part's entity tag, verbatim. Pass it back unchanged to complete the upload."),
    size: z.number().int().nonnegative().describe("The part's size in bytes, as R2 stored it."),
  })
  .describe("One uploaded part of a multipart upload — the unit a resumed upload skips re-sending.");
export type R2UploadedPart = z.output<typeof R2UploadedPart>;

/** One page of object keys from a bucket listing. */
export const R2ObjectListing = z
  .object({
    keys: z.array(z.string().min(1)).describe("The object keys in this page, in R2's lexicographic order."),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("Continuation cursor for the next page. Absent means this page was the last."),
  })
  .describe("One page of an R2 bucket listing. Pagination is caller-driven — pass `cursor` back to advance.");
export type R2ObjectListing = z.output<typeof R2ObjectListing>;

/**
 * A multipart upload that was started and never completed or aborted.
 *
 * Abandoned uploads are invisible and not free — R2 stores and bills their parts, and a bucket holding
 * one cannot be deleted at all.
 */
export const R2PendingUpload = z
  .object({
    key: z.string().min(1).describe("The object key this upload would have assembled into."),
    uploadId: z.string().min(1).describe("The id `abortMultipartUpload` needs in order to reclaim it."),
    initiated: z.date().optional().describe("When the upload was started, for age-based reclamation."),
  })
  .describe("A multipart upload started and never completed or aborted — billed, invisible, and blocking.");
export type R2PendingUpload = z.output<typeof R2PendingUpload>;

/**
 * Whether a thrown S3 error is a 404.
 *
 * `isNotFoundError` from `client/errors` reads `error.status`, which the `cloudflare` SDK sets and the
 * AWS SDK does not — the AWS SDK reports the code on `$metadata.httpStatusCode` and names the shape
 * `NotFound` (HEAD) or `NoSuchKey` (GET). So the S3 protocol needs its own check; sharing one would
 * silently classify every missing object as a request failure.
 */
function isS3NotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "NotFound" || name === "NoSuchKey") return true;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return metadata?.httpStatusCode === 404;
}

/**
 * Out-of-Worker Cloudflare R2 access over the S3 protocol: presigned URLs the client uses to move
 * bytes directly, plus the server-side object and multipart operations that surround them. Inside a
 * Worker you use the R2 binding for object reads and writes; this manager is the REST/S3 counterpart,
 * addressed by bucket name, and the only path to *presigned* multipart — the binding's multipart API
 * streams bytes through the Worker, which defeats the point.
 *
 * Only `uploadPart` is presigned. Create, complete, abort, list, head, copy and delete are server-side
 * calls the holder of the credentials makes directly — presigning them would hand a client authority
 * it has no reason to hold.
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

  /**
   * Presign a PUT URL for uploading one whole object. Valid for one hour unless `expiresIn` says otherwise.
   *
   * **`ContentLength` is signed; `ContentType` is not.** The length lands in `X-Amz-SignedHeaders`, so
   * the client must send exactly that byte count — the signature is the enforcement, and that is
   * deliberate for a whole-object upload: the caller already knows the size (it is what a quota check
   * was run against), so signing it stops a client from spending more storage than it was granted.
   *
   * The type cannot be enforced this way at all. `@aws-sdk/s3-request-presigner` marks `content-type`
   * unsignable before signing (`prepareRequest` → `unsignableHeaders.add("content-type")`), because a
   * browser rewrites the header on a form or an XHR upload and a signature over it would break every
   * such client. It therefore never reaches `X-Amz-SignedHeaders`, and R2 stores whatever type the
   * client's PUT actually carries. `contentType` here is documentation of intent, not a constraint —
   * unlike {@link createMultipartUpload}, which is a server-side call and does pin the type it sends.
   * Anything keyed on an object's type must read it back with {@link headObject} after the upload,
   * never from what the caller declared.
   */
  async createUploadUrl(
    key: string,
    contentType: string,
    contentLength: number,
    options: PresignOptions = {},
  ): Promise<string> {
    return cloudflareRequest(`R2 presign upload for '${key}'`, () => {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      });
      return getSignedUrl(this.getS3Client(), command, {
        expiresIn: options.expiresIn ?? PRESIGN_EXPIRY_SECONDS,
      });
    });
  }

  /** Presign a GET URL for downloading one object. Valid for one hour unless `expiresIn` says otherwise. */
  async createDownloadUrl(key: string, options: PresignOptions = {}): Promise<string> {
    return cloudflareRequest(`R2 presign download for '${key}'`, () => {
      const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      return getSignedUrl(this.getS3Client(), command, {
        expiresIn: options.expiresIn ?? PRESIGN_EXPIRY_SECONDS,
      });
    });
  }

  /**
   * Open a multipart upload and return its `uploadId`. Server-side — no presigning. The id is the
   * handle every later part, completion, abort and resume is addressed by, so a caller that means to
   * support resuming must persist it.
   *
   * R2's multipart shape: at most 10,000 parts, every part but the last at least 5 MiB, each at most
   * 5 GiB. Nothing here enforces that — R2 rejects a violating `complete`, and the part-size policy
   * belongs to the layer that chose the part size.
   */
  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    return cloudflareRequest(`R2 create multipart upload for '${key}'`, async () => {
      const response = await this.getS3Client().send(
        new CreateMultipartUploadCommand({ Bucket: this.bucketName, Key: key, ContentType: contentType }),
      );
      return decodeResponse(
        z.string().min(1).describe("The multipart upload id."),
        response.UploadId,
        `R2 create multipart upload for '${key}'`,
      );
    });
  }

  /**
   * Presign a PUT URL for one part of a multipart upload. This is the only multipart step a client
   * ever touches, and therefore the only one presigned.
   *
   * **`ContentLength` is omitted by default**, unlike `createUploadUrl`. A signed length forces the
   * client to send exactly that many bytes, and for a multipart upload the last part's length is
   * `total - partSize * (n - 1)` — a different number from every other part. Signing it would mean
   * either knowing the total size at mint time (a resumable or streaming upload does not) or minting
   * the final part's URL through a separate code path. Neither earns its complexity: R2 already
   * enforces the 5 MiB floor and 5 GiB ceiling per part, and the whole-object size is enforced where
   * it matters — at `completeMultipartUpload`, against the parts R2 actually stored. A caller that
   * does know the exact part size may still pin it by passing `contentLength`.
   */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: PresignPartOptions = {},
  ): Promise<string> {
    return cloudflareRequest(`R2 presign part ${partNumber} for '${key}'`, () => {
      const command = new UploadPartCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ...(options.contentLength === undefined ? {} : { ContentLength: options.contentLength }),
      });
      return getSignedUrl(this.getS3Client(), command, {
        expiresIn: options.expiresIn ?? PRESIGN_EXPIRY_SECONDS,
      });
    });
  }

  /**
   * Assemble the uploaded parts into one object. Server-side — the client only ever reports the
   * `{ partNumber, etag }` pairs its part PUTs returned.
   *
   * Parts are sorted ascending before the call: S3 rejects an out-of-order part list, and the order a
   * client finishes concurrent part uploads in is not the order they belong in. ETags pass through
   * verbatim — they are opaque to us, and R2 compares them byte for byte.
   */
  async completeMultipartUpload(key: string, uploadId: string, parts: readonly CompletedPart[]): Promise<void> {
    await cloudflareRequest(`R2 complete multipart upload for '${key}'`, async () => {
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      await this.getS3Client().send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: ordered.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    });
  }

  /**
   * Discard an in-flight multipart upload and the parts already stored under it. Idempotent — an
   * upload id R2 has already forgotten is not an error, so a sweep or a retried teardown can re-run.
   */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await cloudflareRequest(`R2 abort multipart upload for '${key}'`, async () => {
      try {
        await this.getS3Client().send(
          new AbortMultipartUploadCommand({ Bucket: this.bucketName, Key: key, UploadId: uploadId }),
        );
      } catch (error) {
        if (isS3NotFound(error)) return;
        throw error;
      }
    });
  }

  /**
   * List the parts already stored against an in-flight upload, ascending. This is what makes an upload
   * resumable: a client that lost its progress asks which parts landed and re-sends only the rest.
   *
   * Pagination is drained here rather than surfaced. An upload holds at most 10,000 parts and a page
   * holds 1000, so the loop is bounded at ten calls — a cursor would be API surface for no gain.
   */
  async listParts(key: string, uploadId: string): Promise<R2UploadedPart[]> {
    return cloudflareRequest(`R2 list parts for '${key}'`, async () => {
      const parts: R2UploadedPart[] = [];
      let marker: string | undefined;
      do {
        const response = await this.getS3Client().send(
          new ListPartsCommand({
            Bucket: this.bucketName,
            Key: key,
            UploadId: uploadId,
            MaxParts: LIST_PARTS_PAGE_SIZE,
            PartNumberMarker: marker,
          }),
        );
        for (const part of response.Parts ?? []) {
          parts.push(
            decodeResponse(
              R2UploadedPart,
              { partNumber: part.PartNumber, etag: part.ETag, size: part.Size },
              `R2 list parts for '${key}'`,
            ),
          );
        }
        marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
      } while (marker);
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    });
  }

  /**
   * Read one object's metadata without transferring its body. Returns `null` when the object is
   * absent — a missing object is an answer, not a failure, and the caller decides what it means.
   */
  async headObject(key: string): Promise<R2ObjectHead | null> {
    return cloudflareRequest(`R2 head object '${key}'`, async () => {
      try {
        const response = await this.getS3Client().send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key }));
        return decodeResponse(
          R2ObjectHead,
          {
            size: response.ContentLength,
            etag: response.ETag,
            contentType: response.ContentType,
            uploaded: response.LastModified,
          },
          `R2 head object '${key}'`,
        );
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    });
  }

  /**
   * Every multipart upload started in this bucket and never completed or aborted.
   *
   * Abandoned uploads are invisible and not free: R2 stores and bills the parts, and a bucket holding one
   * cannot be deleted at all. Nothing else can find them — `listObjects` does not show an upload that never
   * assembled, and `listParts` needs the `uploadId` you are trying to discover. So this is the only route to
   * reclaiming a bucket, and the only way an orphan sweep can see the cost it is meant to reclaim.
   *
   * Fully drained rather than cursor-paged: a caller wants all of them, and the count is bounded by how many
   * uploads were abandoned rather than by how much data the bucket holds.
   */
  async listMultipartUploads(prefix?: string): Promise<R2PendingUpload[]> {
    return cloudflareRequest("R2 list multipart uploads", async () => {
      const found: R2PendingUpload[] = [];
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      do {
        const response = await this.getS3Client().send(
          new ListMultipartUploadsCommand({
            Bucket: this.bucketName,
            Prefix: prefix,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        );
        for (const upload of response.Uploads ?? []) {
          if (!upload.Key || !upload.UploadId) continue;
          found.push(
            decodeResponse(
              R2PendingUpload,
              { key: upload.Key, uploadId: upload.UploadId, initiated: upload.Initiated },
              "R2 pending multipart upload",
            ),
          );
        }
        keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
        uploadIdMarker = response.IsTruncated ? response.NextUploadIdMarker : undefined;
      } while (keyMarker || uploadIdMarker);
      return found;
    });
  }

  /**
   * List one page of object keys. Pagination is caller-driven: pass the returned `cursor` back to get
   * the next page, and stop when it is absent. Unlike `listParts` a bucket has no bounded size, so
   * draining it here would be an unbounded loop with no way for the caller to stop early.
   */
  async listObjects(options: ListObjectsOptions = {}): Promise<R2ObjectListing> {
    return cloudflareRequest("R2 list objects", async () => {
      const response = await this.getS3Client().send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: options.prefix,
          ContinuationToken: options.cursor,
          MaxKeys: options.maxKeys,
        }),
      );
      const keys = (response.Contents ?? []).map((entry) => entry.Key).filter((key): key is string => Boolean(key));
      return decodeResponse(
        R2ObjectListing,
        // A truncated page always carries a continuation token; guard anyway so a token without the
        // truncation flag can never strand the caller mid-listing.
        { keys, cursor: response.IsTruncated ? response.NextContinuationToken : undefined },
        "R2 list objects",
      );
    });
  }

  /**
   * Copy an object within this bucket, server-side — the bytes never leave R2.
   *
   * `CopySource` is `/<bucket>/<key>` with the key percent-encoded per path segment. The SDK does not
   * encode it, and a key containing a space or `?` produces a malformed source header otherwise;
   * encoding whole would destroy the `/` separators a nested key depends on.
   */
  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    await cloudflareRequest(`R2 copy '${sourceKey}' to '${destKey}'`, async () => {
      const source = `/${this.bucketName}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
      await this.getS3Client().send(
        new CopyObjectCommand({ Bucket: this.bucketName, Key: destKey, CopySource: source }),
      );
    });
  }

  /**
   * Delete one object. Idempotent by protocol — S3 answers a delete of an absent key with a success,
   * so teardown and orphan sweeps can re-run safely.
   */
  async deleteObject(key: string): Promise<void> {
    await cloudflareRequest(`R2 delete object '${key}'`, async () => {
      await this.getS3Client().send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
    });
  }

  /**
   * Delete every object in this bucket and abort every multipart upload still in flight.
   *
   * **R2 refuses to delete a bucket that is not empty**, so this is the step that has to run before
   * `CloudflareR2Provisioner.deleteBucket` — and it is the reason a teardown needs the S3 key pair at
   * all: the CF API has no object plane, so nothing but this protocol can empty a bucket.
   *
   * Two different things hold a bucket, and only one of them is visible. Stored objects show up in a
   * listing; the parts of an upload that was started and never completed or aborted do not, and they
   * block the delete just the same. So the aborts go first: draining the keys of a bucket that still
   * carries a dangling upload leaves it empty-looking and undeletable, which is the confusing failure.
   *
   * **Destructive and unrecoverable**, and it does not ask — the caller owns the confirmation. Idempotent:
   * an already-empty bucket is a no-op reporting zeroes, so a retried teardown is safe.
   */
  async emptyBucket(): Promise<R2BucketDrain> {
    let uploadsAborted = 0;
    for (const pending of await this.listMultipartUploads()) {
      await this.abortMultipartUpload(pending.key, pending.uploadId);
      uploadsAborted += 1;
    }

    let objectsDeleted = 0;
    let cursor: string | undefined;
    do {
      const page = await this.listObjects({ cursor });
      for (const key of page.keys) {
        await this.deleteObject(key);
        objectsDeleted += 1;
      }
      cursor = page.cursor;
    } while (cursor);

    return { objectsDeleted, uploadsAborted };
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
