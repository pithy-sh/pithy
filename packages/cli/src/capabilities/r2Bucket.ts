// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * The R2 bucket steps `pithy storage` and `pithy media` share: resolving the S3 key pair, and taking a
 * bucket down with everything in it.
 *
 * Both capabilities provision a per-environment bucket and both tear one down, so the sequence lives
 * here rather than twice. It sits in the CLI provisioner layer, not in either package: the packages own
 * the *orchestration* (which environments, in what order) behind a seam they unit-test with a fake, and
 * the live Cloudflare calls are deliberately on this side of that seam.
 */

/**
 * Resolve the R2 S3 key pair: the explicit flags first, then `R2_CREDENTIALS` in `.dev.vars`. Both legs
 * validate through the canonical {@link R2Credentials} schema, so a half-supplied or malformed pair fails
 * here rather than at the Worker's first presign — or, on teardown, half way through deleting buckets.
 */
export function resolveR2Credentials(
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
  raw: string | undefined,
): R2Credentials {
  if (accessKeyId || secretAccessKey) {
    const parsed = R2Credentials.safeParse({ accessKeyId, secretAccessKey });
    if (!parsed.success) {
      throw new ValidationError({
        message: "The R2 access-key pair is incomplete.",
        action: "Pass both --r2-access-key-id and --r2-secret-access-key.",
      });
    }
    return parsed.data;
  }
  if (!raw) {
    throw new ValidationError({
      message: "No R2 S3 credentials were supplied.",
      action:
        "Pass --r2-access-key-id and --r2-secret-access-key, or set R2_CREDENTIALS in .dev.vars. Create the pair under R2 → Manage API tokens; Cloudflare has no API for minting one.",
    });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ValidationError({
      message: "R2_CREDENTIALS is not valid JSON.",
      action: 'Set R2_CREDENTIALS to {"accessKeyId":"…","secretAccessKey":"…"}.',
    });
  }
  const parsed = R2Credentials.safeParse(decoded);
  if (!parsed.success) {
    throw new ValidationError({
      message: "R2_CREDENTIALS is not a valid access-key/secret-key pair.",
      action: 'Set R2_CREDENTIALS to {"accessKeyId":"…","secretAccessKey":"…"}.',
    });
  }
  return parsed.data;
}

/** What a bucket teardown did, so the caller can audit it and report it. */
export interface R2BucketTeardown {
  /** Whether a bucket was there to delete. `false` means teardown found nothing and did nothing. */
  deleted: boolean;
  /** How many stored objects the drain removed before the bucket came down. */
  objectsDeleted: number;
  /** How many abandoned multipart uploads the drain aborted. */
  uploadsAborted: number;
}

/** What deleting one bucket needs: the clients, the S3 key pair the drain runs on, and the name. */
export interface DeleteR2BucketOptions {
  /** The configured Cloudflare clients — the control plane for the delete, the object plane for the drain. */
  cf: CloudflareClients;
  /**
   * The R2 S3 key pair. Optional because a deprovision that does not touch storage never needs one; a
   * teardown that reaches a real bucket without it fails with an actionable error instead of a SigV4 fault.
   */
  credentials?: R2Credentials;
  /** The bucket to remove, by name — R2's only address for one. */
  bucketName: string;
}

/**
 * Delete a bucket **and everything in it**, or do nothing if it is not there.
 *
 * Drain first, then delete. R2 rejects the delete of a non-empty bucket, so a teardown that only called
 * the control plane worked on an untouched bucket and failed on every bucket anyone had actually used —
 * the one case it exists for. Emptying is an S3-protocol operation the CF API cannot express, which is
 * why this needs the key pair and the plain `deleteBucket` above it does not.
 *
 * Idempotent end to end: a missing bucket, an empty one, and a retried run all land the same way.
 */
export async function deleteR2BucketWithContents(options: DeleteR2BucketOptions): Promise<R2BucketTeardown> {
  const existing = await options.cf.r2Provisioner().findBucketByName(options.bucketName);
  if (!existing) return { deleted: false, objectsDeleted: 0, uploadsAborted: 0 };

  const credentials = options.credentials;
  if (!credentials) {
    throw new ValidationError({
      message: `The R2 access-key pair is needed to delete the ${existing.name} bucket.`,
      action: "Pass --r2-access-key-id and --r2-secret-access-key, or set R2_CREDENTIALS in .dev.vars.",
      detail: "R2 refuses to delete a non-empty bucket, and emptying one is an S3-protocol operation.",
    });
  }

  const drain = await options.cf.r2({ ...credentials, bucketName: existing.name }).emptyBucket();
  await options.cf.r2Provisioner().deleteBucket(existing.name);
  return { deleted: true, ...drain };
}
