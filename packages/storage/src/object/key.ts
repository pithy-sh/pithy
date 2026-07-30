// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Key **policy** for the storage capability. It lives here, apart from {@link ObjectStore}, because
 * the store is *mechanism*: it takes an explicit key and moves bytes, and knows nothing about how
 * that key was chosen. Storage derives `obj/<uuid>`; `@pithy-sh/media` passes `media/<type>/<id>`.
 * Neither package knows the other's scheme, which is exactly what lets media import the seam without
 * inheriting storage's opaque-key decision.
 *
 * Why the key is server-derived and opaque. The client supplies a *logical* path
 * (`invoices/2026/q3.pdf`) that is stored, indexed, and listed from D1; it never reaches R2. So a
 * `../` cannot escape a prefix, two clients cannot collide on a name, and no client-controlled text
 * is ever interpolated into a key. It also sidesteps R2's one-write-per-second-per-key limit by
 * construction: every object gets its own key, so no two writes ever contend for one.
 */

/** Every key this capability derives starts here, so a bucket sweep can tell its objects from a co-tenant's. */
export const OBJECT_KEY_PREFIX = "obj/";

/** R2's hard limit on an object key, in bytes. A derived key is 40 bytes, so this guards pass-through keys only. */
export const MAX_OBJECT_KEY_BYTES = 1024;

/**
 * A fresh opaque object key. UUIDv4 from the platform CSPRNG — unguessable, so a leaked key is not a
 * directory listing, and unique, so a re-upload never overwrites a live object.
 */
export function deriveObjectKey(): string {
  return `${OBJECT_KEY_PREFIX}${crypto.randomUUID()}`;
}

/** Whether `key` is one this capability derived. The sweep uses it to leave a co-tenant's objects alone. */
export function isDerivedObjectKey(key: string): boolean {
  return key.startsWith(OBJECT_KEY_PREFIX);
}

/** Whether `key` fits R2's 1,024-**byte** key limit. Measured in bytes, not characters — a key may be UTF-8. */
export function isValidObjectKey(key: string): boolean {
  return key.length > 0 && new TextEncoder().encode(key).length <= MAX_OBJECT_KEY_BYTES;
}
