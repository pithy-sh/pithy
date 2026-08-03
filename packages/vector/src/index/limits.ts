// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";

/**
 * Vectorize's published ceilings, in one place, verified against
 * https://developers.cloudflare.com/vectorize/platform/limits/ and
 * https://developers.cloudflare.com/vectorize/reference/metadata-filtering/ on 2026-07-27.
 *
 * They live here rather than inline at each call site for one reason: a limit that is enforced in two places
 * eventually disagrees with itself. Every guard in this package reads a const from this file, so the number
 * an error message quotes is the number the check used.
 *
 * Nothing here throws. These are values and predicates; the typed errors are raised by the module that owns
 * the boundary (`index/index.ts` for a query or an upsert, `index/filter.ts` for a filter, `config/config.ts`
 * for a config parse), because that module knows which `vector/*` code applies.
 */

/** Components per vector, float32. An index's `dimensions` is fixed at creation and cannot be changed. */
export const MAX_DIMENSIONS = 1536;

/**
 * Bytes in an index name, a namespace name, or any other Vectorize identifier.
 *
 * The index-name half of this is the same number the naming facade holds
 * (`NAMESPACE_LIMITS.vectorizeIndex` in `@pithy-sh/core/src/naming/limits`), so it is read from there
 * rather than typed twice — a limit written in two files eventually disagrees with itself. The rest of
 * Vectorize's identifiers share the ceiling but are not composed by the facade, which is why this
 * package still owns the constant they are checked against.
 *
 * Vectorize also constrains the charset: `^([a-z]+[a-z0-9_-]*[a-z0-9]+)$` — an index name must **start
 * with a letter** and end alphanumeric. Pithy's project rule already requires a letter-leading project,
 * and every composed name leads with the project, so the two agree by construction.
 */
export const MAX_NAME_BYTES = NAMESPACE_LIMITS.vectorizeIndex.maxLength;

/** Bytes in a vector id. A document whose id exceeds this can be stored but never addressed in the index. */
export const MAX_VECTOR_ID_BYTES = 64;

/**
 * Bytes of metadata carried on one vector. Long source text belongs in D1, which is why this package has a table.
 * Like the filter ceiling, the compact JSON must be **under** this — 10,240 is already too large.
 */
export const MAX_METADATA_BYTES = 10 * 1024;

/** The filter's compact JSON must be **under** this — 2,048 is already too large, not the last accepted size. */
export const MAX_FILTER_BYTES = 2048;

/** Characters in a filter key. Vectorize states this as characters, not bytes. */
export const MAX_FILTER_KEY_LENGTH = 512;

/** Metadata indexes per index. A hard ceiling, which is what makes filterability a provisioning-time decision. */
export const MAX_METADATA_INDEXES = 10;

/** Vectors per upsert call from a Worker. The HTTP API allows 5,000; the binding does not. */
export const MAX_UPSERT_BATCH = 1000;

/** topK when a query returns values or metadata — the payload makes the response the constraint. */
export const MAX_TOPK_WITH_PAYLOAD = 50;

/** topK when a query returns neither values nor metadata. */
export const MAX_TOPK_WITHOUT_PAYLOAD = 100;

/** Matches a query returns when the caller names no `topK`. Small on purpose: a search page, not a scan. */
export const DEFAULT_TOPK = 10;

const encoder = new TextEncoder();

/** Byte length of a string as UTF-8. Cloudflare states these limits in bytes, and `String.length` is not that. */
export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Why a key is unusable as a metadata filter key, or `null` when it is fine. Vectorize's rules: non-empty, no
 * dots (reserved for nesting into sub-objects), no leading `$` (reserved for operators), at most 512
 * characters. Returned as a message rather than thrown so a config parse can turn it into a Zod issue and a
 * request boundary can turn it into a typed error.
 */
export function filterKeyProblem(key: string): string | null {
  if (key.length === 0) return "a filter key cannot be empty";
  if (key.startsWith("$")) return `\`${key}\` starts with $, which Vectorize reserves for operators`;
  if (key.includes(".")) return `\`${key}\` contains a dot, which Vectorize reserves for nested fields`;
  if (key.length > MAX_FILTER_KEY_LENGTH) {
    return `\`${key.slice(0, 32)}…\` is longer than ${MAX_FILTER_KEY_LENGTH} characters`;
  }
  return null;
}
