// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket, R2Conditional, R2Object, R2Range, ReadableStream } from "@cloudflare/workers-types";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { z } from "zod";
import { type R2StorageCredentials, r2CredentialsRegistry, STORAGE_R2_SECRET } from "../secret/registry";
import { r2Presigned } from "./cloudflare";
import type { ReportedPart } from "./multipart";

/**
 * `ObjectStore` — the object-plane seam, and the one piece of this package that is reusable outside it.
 *
 * **The load-bearing constraint: this module imports no D1, no routes, and no storage config.** It is
 * constructed over an injected bucket binding and a *named* credential secret, which is exactly what
 * lets `@pithy-sh/media` import it, point it at `MEDIA_BUCKET` under `media-r2-credentials`, and
 * inherit none of storage's tables, routes, or opaque-key policy. Adding `@pithy-sh/storage` to media
 * must not mount storage's routes or create `pithy_storage_objects`; keeping this file free of those
 * imports is what guarantees it.
 *
 * It is **mechanism only**. It takes an explicit key and moves bytes. Key policy lives in `key.ts` and
 * in the handlers: storage derives `obj/<uuid>`, media passes `media/<type>/<id>`, and neither knows
 * the other's scheme.
 *
 * **Bindings inside the Worker, S3 outside it** (CLAUDE.md §Cloudflare access). Reads, head, list and
 * delete go through the `R2Bucket` binding — no credentials, no round trip, and a body that streams.
 * Presigned URLs, the multipart lifecycle, and server-side copy have no binding equivalent that keeps
 * bytes out of the Worker, so they go over the S3 protocol through `@pithy-sh/cloudflare`. The seam
 * hides which is which; only `object/cloudflare.ts` touches the manager.
 *
 * Every response crossing the seam is Zod-validated, so an unexpected shape fails loudly at the
 * boundary rather than surfacing as `undefined` three layers up.
 */

/** An object's metadata, as either a HEAD or a GET reports it. */
export const ObjectMetadata = z
  .object({
    key: z.string().min(1).describe("The R2 object key. Opaque to the caller — policy lives in `key.ts`."),
    size: z.number().int().nonnegative().describe("The whole object's size in bytes, not the served range's."),
    etag: z
      .string()
      .min(1)
      .describe("R2's entity tag for this object version, unquoted. Quote it before it becomes an `ETag` header."),
    contentType: z
      .string()
      .min(1)
      .optional()
      .describe("The stored `Content-Type`. Absent when the object was written without one."),
    contentDisposition: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The stored `Content-Disposition`, when one was written. Recorded, not honored — the serve path derives its own, because this string is whatever the uploader sent.",
      ),
    uploaded: z.date().describe("When R2 wrote this object version."),
    checksumSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Lowercase hex SHA-256, when R2 holds one. Absent unless the upload supplied or requested it."),
  })
  .describe("One object's metadata — everything a serve path needs without transferring the body.");
export type ObjectMetadata = z.output<typeof ObjectMetadata>;

/** Which bytes of an object to read. Mirrors R2's own range shapes; exactly one form is meaningful. */
export const ObjectRange = z
  .object({
    offset: z.number().int().nonnegative().optional().describe("First byte to read, from the start of the object."),
    length: z.number().int().positive().optional().describe("How many bytes to read from `offset`."),
    suffix: z.number().int().positive().optional().describe("Read this many bytes from the *end* — `bytes=-N`."),
  })
  .describe("A byte range to read, as an HTTP `Range` header maps onto R2.");
export type ObjectRange = z.output<typeof ObjectRange>;

/** Preconditions a read must satisfy, so a conditional request can answer 304 without moving bytes. */
export const ObjectConditions = z
  .object({
    etagMatches: z.string().min(1).optional().describe("Read only if the object's etag equals this (`If-Match`)."),
    etagDoesNotMatch: z
      .string()
      .min(1)
      .optional()
      .describe("Read only if the object's etag differs (`If-None-Match`) — the 304 path."),
    uploadedBefore: z
      .date()
      .optional()
      .describe("Read only if the object was written before this (`If-Unmodified-Since`)."),
    uploadedAfter: z
      .date()
      .optional()
      .describe("Read only if the object was written after this (`If-Modified-Since`)."),
  })
  .describe("Conditional-read preconditions. R2 returns metadata with no body when one fails.");
export type ObjectConditions = z.output<typeof ObjectConditions>;

/** One page of a bucket listing — the sweep's view, distinct from the D1 listing an owner sees. */
export const ObjectListing = z
  .object({
    objects: z.array(ObjectMetadata).describe("This page's objects, in R2's lexicographic key order."),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("Continuation cursor for the next page. Absent means this page was the last."),
  })
  .describe("One page of a bucket listing. Pagination is caller-driven — pass `cursor` back to advance.");
export type ObjectListing = z.output<typeof ObjectListing>;

/** One part already stored against an in-flight multipart upload — what makes an upload resumable. */
export const UploadedPart = z
  .object({
    partNumber: z.number().int().min(1).describe("The part's 1-based index within the upload."),
    etag: z.string().min(1).describe("The part's entity tag, verbatim. Pass it back unchanged to complete."),
    size: z.number().int().nonnegative().describe("The part's size in bytes, as R2 stored it."),
  })
  .describe("One uploaded part — the unit a resumed upload skips re-sending.");
export type UploadedPart = z.output<typeof UploadedPart>;

/** How long a presigned URL stays valid. */
export interface PresignOptions {
  /** Lifetime in seconds. Defaults to one hour — long enough for a large part, short enough to leak little. */
  expiresIn?: number;
}

/** Presign options for one part, which may additionally pin its exact byte count. */
export interface PresignPartOptions extends PresignOptions {
  /** Exact byte count the client must send. Omitted by default; see `presignPart`. */
  contentLength?: number;
}

/** What to read, and under what preconditions. */
export interface GetOptions {
  /** Serve only this byte range (206). */
  range?: ObjectRange;
  /** Serve only if these preconditions hold; otherwise the result carries metadata and no body (304). */
  onlyIf?: ObjectConditions;
}

/** Which slice of the bucket to list. */
export interface ListOptions {
  /** Only keys starting with this prefix. Omitted lists the whole bucket. */
  prefix?: string;
  /** Continuation cursor from a previous page. */
  cursor?: string;
  /** Page size. R2 caps this at 1,000. */
  limit?: number;
}

/** An object read: its metadata, its bytes, and the range R2 actually served. */
export interface ObjectBody {
  /** The whole object's metadata — `size` is the object's, not the range's. */
  metadata: ObjectMetadata;
  /** The bytes, streamed. `null` when a precondition failed, which is the 304 signal. */
  body: ReadableStream | null;
  /** The byte range R2 served, when a range was asked for. `null` means the whole object. */
  range: { offset: number; length: number } | null;
}

/**
 * The S3-protocol half of the seam: everything the R2 binding cannot do without pulling bytes through
 * the Worker. Declared here as a structural port so `store.ts` never imports `@pithy-sh/cloudflare`,
 * and so a test can drive the store with no SDK and no network.
 */
export interface PresignedObjects {
  /**
   * Presign a PUT for one whole object. The length is signed, so the client must send exactly that many
   * bytes. The type is **not** — S3 presigning marks `content-type` unsignable — so it is a hint the
   * completion reconciles against what R2 actually stored.
   */
  presignPut(key: string, contentType: string, contentLength: number, options?: PresignOptions): Promise<string>;
  /** Presign a GET for one object. */
  presignGet(key: string, options?: PresignOptions): Promise<string>;
  /** Open a multipart upload; returns the `uploadId` every later step is addressed by. */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** Presign a PUT for one part — the only multipart step a client ever touches. */
  presignUploadPart(key: string, uploadId: string, partNumber: number, options?: PresignPartOptions): Promise<string>;
  /** Assemble the uploaded parts into one object. */
  completeMultipartUpload(key: string, uploadId: string, parts: readonly ReportedPart[]): Promise<void>;
  /** Discard an in-flight upload and its stored parts. Idempotent. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** List the parts already stored against an in-flight upload, ascending. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  /** Copy an object within the bucket, server-side — the bytes never leave R2. */
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
}

/** The object plane: presigned transfer, the multipart lifecycle, and binding-backed reads. */
export interface ObjectStore {
  /** Presign a PUT the client uploads a whole object to. Bytes never proxy through the Worker. */
  presignPut(key: string, contentType: string, contentLength: number, options?: PresignOptions): Promise<string>;
  /** Presign a GET — the escape hatch for serving without a Worker in the byte path. */
  presignGet(key: string, options?: PresignOptions): Promise<string>;
  /** Open a multipart upload. Persist the returned `uploadId`: it is the handle a resume needs. */
  initMultipart(key: string, contentType: string): Promise<string>;
  /**
   * Presign a PUT for one part. `contentLength` is **not** signed by default: the final part's length
   * differs from every other, so signing it would mean knowing the total size at mint time. R2 enforces
   * the 5 MiB floor and 5 GiB ceiling itself, and the object's real size is confirmed at completion.
   */
  presignPart(key: string, uploadId: string, partNumber: number, options?: PresignPartOptions): Promise<string>;
  /** Assemble the reported parts into one object. Order and completeness are checked before R2 sees them. */
  completeMultipart(key: string, uploadId: string, parts: readonly ReportedPart[]): Promise<void>;
  /** Abort an in-flight upload. Idempotent, so a sweep or a retried teardown can re-run. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** The parts already stored against an in-flight upload — what a resuming client asks for. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  /** Read an object through the binding, honoring a range and conditional preconditions. `null` when absent. */
  get(key: string, options?: GetOptions): Promise<ObjectBody | null>;
  /** Read an object's metadata without its body. `null` when absent — a missing object is an answer. */
  head(key: string): Promise<ObjectMetadata | null>;
  /** One page of bucket keys. The orphan sweep's view; an owner's file list comes from D1. */
  list(options?: ListOptions): Promise<ObjectListing>;
  /** Server-side copy within the bucket. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  /** Delete one object. Idempotent by protocol. */
  delete(key: string): Promise<void>;
}

/** How to build an object store. */
export interface ObjectStoreOptions {
  /** The R2 bucket binding — `STORAGE_BUCKET` for storage, `MEDIA_BUCKET` for media. */
  bucket: R2Bucket;
  /**
   * The env the credential secret resolves against. Only ever handed to `sharedSecretsStore`; no
   * binding on it is read directly (CLAUDE.md §Secrets).
   */
  env: SecretsStoreEnv;
  /**
   * The registry name the R2 credential bundle is stored under. Whatever name is passed, the *same*
   * capability must have declared it with `r2CredentialsRegistry(name)` — a name no capability
   * declared is absent from the aggregated registry and throws on first use.
   */
  secretName?: string;
  /**
   * Test seam: build the S3 port from resolved credentials. Defaults to the real R2 adapter. Overriding
   * it is how a test drives the store with no SDK, no credentials, and no network.
   */
  presigned?: (credentials: R2StorageCredentials) => PresignedObjects;
}

/** Map our range shape onto R2's — the binding's union admits exactly one of these three forms. */
function toR2Range(range: ObjectRange | undefined): R2Range | undefined {
  if (!range) return undefined;
  if (range.suffix !== undefined) return { suffix: range.suffix };
  if (range.offset !== undefined && range.length !== undefined) return { offset: range.offset, length: range.length };
  if (range.offset !== undefined) return { offset: range.offset };
  if (range.length !== undefined) return { length: range.length };
  return undefined;
}

/** Lowercase hex for a checksum R2 hands back as raw bytes. */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate an `R2Object` into {@link ObjectMetadata} — the one place binding shapes cross the seam. */
function toMetadata(object: R2Object): ObjectMetadata {
  return ObjectMetadata.parse({
    key: object.key,
    size: object.size,
    etag: object.etag,
    contentType: object.httpMetadata?.contentType,
    contentDisposition: object.httpMetadata?.contentDisposition,
    uploaded: object.uploaded,
    checksumSha256: object.checksums?.sha256 ? toHex(object.checksums.sha256) : undefined,
  });
}

/**
 * Build an object store over a bucket binding and a named credential secret.
 *
 * Credentials resolve **lazily, once**: a read-only worker that never presigns never touches the
 * secrets store, and a worker that presigns twice resolves once. The promise itself is memoized, so
 * two concurrent presigns share one resolution rather than racing two.
 */
export function objectStore(options: ObjectStoreOptions): ObjectStore {
  const secretName = options.secretName ?? STORAGE_R2_SECRET;
  const build = options.presigned ?? r2Presigned;
  const bucket = options.bucket;
  let presignedPromise: Promise<PresignedObjects> | null = null;

  function presigned(): Promise<PresignedObjects> {
    if (!presignedPromise) {
      presignedPromise = (async () => {
        const registry = r2CredentialsRegistry(secretName);
        const store = await sharedSecretsStore(options.env, registry);
        return build(store.get(secretName));
      })();
    }
    return presignedPromise;
  }

  return {
    async presignPut(key, contentType, contentLength, presignOptions) {
      return (await presigned()).presignPut(key, contentType, contentLength, presignOptions);
    },

    async presignGet(key, presignOptions) {
      return (await presigned()).presignGet(key, presignOptions);
    },

    async initMultipart(key, contentType) {
      return (await presigned()).createMultipartUpload(key, contentType);
    },

    async presignPart(key, uploadId, partNumber, presignOptions) {
      return (await presigned()).presignUploadPart(key, uploadId, partNumber, presignOptions);
    },

    async completeMultipart(key, uploadId, parts) {
      await (await presigned()).completeMultipartUpload(key, uploadId, parts);
    },

    async abortMultipart(key, uploadId) {
      await (await presigned()).abortMultipartUpload(key, uploadId);
    },

    async listParts(key, uploadId) {
      return (await presigned()).listParts(key, uploadId);
    },

    async get(key, getOptions) {
      const conditions = getOptions?.onlyIf;
      const object = await bucket.get(key, {
        range: toR2Range(getOptions?.range),
        onlyIf: conditions ? (conditions as R2Conditional) : undefined,
      });
      if (!object) return null;
      // A failed precondition yields an `R2Object` with no `body` — that absence *is* the 304 signal,
      // so it is surfaced as a null body rather than swallowed as a miss.
      const body = "body" in object ? object.body : null;
      // R2 reports a range on *every* read, including a whole-object one. Only echo it when a range was
      // asked for, so `range: null` keeps meaning "the whole object" and a serve path can key `206` off it.
      const served = getOptions?.range && object.range ? object.range : undefined;
      const offset = served && "offset" in served ? (served.offset ?? 0) : 0;
      const length = served && "length" in served ? (served.length ?? 0) : 0;
      return {
        metadata: toMetadata(object),
        body,
        range: served ? { offset, length } : null,
      };
    },

    async head(key) {
      const object = await bucket.head(key);
      return object ? toMetadata(object) : null;
    },

    async list(listOptions) {
      const page = await bucket.list({
        prefix: listOptions?.prefix,
        cursor: listOptions?.cursor,
        limit: listOptions?.limit,
      });
      return ObjectListing.parse({
        objects: page.objects.map(toMetadata),
        cursor: page.truncated ? page.cursor : undefined,
      });
    },

    async copy(sourceKey, destinationKey) {
      await (await presigned()).copyObject(sourceKey, destinationKey);
    },

    async delete(key) {
      await bucket.delete(key);
    },
  };
}
