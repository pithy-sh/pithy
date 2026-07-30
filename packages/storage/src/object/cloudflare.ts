// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import type { R2StorageCredentials } from "../secret/registry";
import { type PresignedObjects, UploadedPart } from "./store";

/**
 * The SDK-friction boundary: the one file in this package that touches `@pithy-sh/cloudflare`.
 *
 * `store.ts` declares {@link PresignedObjects} as a structural port and never imports a manager, so
 * the seam stays testable with no SDK and no network, and so the S3 client's shape can change without
 * reaching the store. This adapter is the only thing that knows a `CloudflareR2Manager` exists.
 *
 * Every value crossing back is re-validated with the seam's own Zod objects — the manager's schemas
 * are its contract, not ours, and a shape drift should fail here rather than three layers up.
 */

/** Adapt a {@link CloudflareR2Manager} to the {@link PresignedObjects} port. */
export function r2Manager(manager: CloudflareR2Manager): PresignedObjects {
  return {
    presignPut: (key, contentType, contentLength, options) =>
      manager.createUploadUrl(key, contentType, contentLength, { expiresIn: options?.expiresIn }),
    presignGet: (key, options) => manager.createDownloadUrl(key, { expiresIn: options?.expiresIn }),
    createMultipartUpload: (key, contentType) => manager.createMultipartUpload(key, contentType),
    presignUploadPart: (key, uploadId, partNumber, options) =>
      manager.presignUploadPart(key, uploadId, partNumber, {
        expiresIn: options?.expiresIn,
        contentLength: options?.contentLength,
      }),
    completeMultipartUpload: (key, uploadId, parts) => manager.completeMultipartUpload(key, uploadId, parts),
    abortMultipartUpload: (key, uploadId) => manager.abortMultipartUpload(key, uploadId),
    async listParts(key, uploadId) {
      const parts = await manager.listParts(key, uploadId);
      return parts.map((part) => UploadedPart.parse(part));
    },
    copyObject: (sourceKey, destinationKey) => manager.copyObject(sourceKey, destinationKey),
  };
}

/**
 * The default port factory: build an R2 manager from the resolved credential bundle and adapt it.
 * This is what `objectStore` calls when no `presigned` seam is injected.
 */
export function r2Presigned(credentials: R2StorageCredentials): PresignedObjects {
  return r2Manager(
    new CloudflareR2Manager({
      apiToken: credentials.apiToken,
      accountId: credentials.accountId,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      bucketName: credentials.bucket,
    }),
  );
}
