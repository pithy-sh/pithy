// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import type { ObjectStore } from "@pithy-sh/storage/src/object/store";

/**
 * Attachment bytes — written through the R2 binding, read back as a short-lived signed URL.
 *
 * The split follows the rule the `ObjectStore` seam already documents and is not a preference:
 * **writes go through the binding, presigning goes over S3.** A write from inside the Worker needs
 * no credentials and no round trip, and the bytes are already in memory because the message was
 * parsed here. A signed URL has no binding equivalent that keeps bytes out of the Worker, so it goes
 * through `@pithy-sh/storage`'s seam against support's own bucket and credential name — inheriting
 * none of storage's tables, routes, or key policy.
 *
 * **Nothing is ever proxied.** A dashboard is handed a URL and fetches from R2 itself. Proxying
 * would put a surface in the data path between an adopter and their own customers' files, which is
 * exactly what principle 1 exists to prevent.
 */

/**
 * How long an attachment URL stays valid.
 *
 * Five minutes, matching `@pithy-sh/storage`'s own download TTL, and short for the reason that
 * package states plainly: a signed URL is bearer-equivalent and cannot be revoked. Long enough to
 * click, short enough that a URL copied out of a browser's history is already dead.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 300;

/** The prefix every object this capability writes lives under. Distinct from storage's `obj/`. */
export const SUPPORT_KEY_PREFIX = "support";

/**
 * Derive the R2 key for an attachment.
 *
 * **Server-derived and opaque**, never built from the declared filename. A filename is
 * attacker-controlled: it can contain a path, a scheme, or a name that collides with somebody
 * else's, and a key derived from one hands a sender partial control over where bytes land. The
 * thread segment is there only so an operator reading a bucket listing can see the shape of what
 * they own; nothing resolves a key by parsing it.
 */
export function attachmentKey(threadId: string, id: string): string {
  return `${SUPPORT_KEY_PREFIX}/${threadId}/${id}`;
}

/** Derive the R2 key for a message's immutable raw MIME. */
export function rawMessageKey(threadId: string, messageId: string): string {
  return `${SUPPORT_KEY_PREFIX}/${threadId}/raw/${messageId}.eml`;
}

/** Lowercase hex SHA-256 of some bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `crypto.subtle` wants an ArrayBuffer view's own buffer slice, not the whole backing store — a
  // `Uint8Array` from a parser is frequently a view into a larger buffer.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Write bytes to the bucket.
 *
 * The stored `contentType` is **`application/octet-stream`, never what the sender declared.** R2
 * echoes the stored type back on a presigned GET, and a browser that receives `text/html` from an
 * object URL will render it — so honouring a declared type here would turn every attachment into a
 * stored-XSS delivery mechanism on whatever origin the bucket serves from, with a signed URL as the
 * exploit. The declared type is kept in D1, where it is data rather than an instruction.
 */
export async function putAttachment(bucket: R2Bucket, key: string, bytes: Uint8Array): Promise<void> {
  await bucket.put(key, bytes.slice().buffer as ArrayBuffer, {
    httpMetadata: { contentType: "application/octet-stream", contentDisposition: "attachment" },
  });
}

/** Mint a short-lived download URL for a stored object. */
export async function attachmentUrl(store: ObjectStore, key: string): Promise<string> {
  return store.presignGet(key, { expiresIn: ATTACHMENT_URL_TTL_SECONDS });
}
