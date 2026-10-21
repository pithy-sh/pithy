// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";

/**
 * **The kit's own codecs whose decode moves nothing** (#132).
 *
 * A codec's decode is a function, and a function can put a marked wire value in any app field, so `redact` masks a
 * codec whole wherever its wire side carries a mark. No schema can prove a decode keeps every value where it was. The
 * kit's own codecs can be read instead: `sqliteJson`'s decode is `JSON.parse`, and the date and boolean codecs convert
 * one scalar. Each registers here, and only these are walked like a plain pipe.
 *
 * The decode function is what is registered, not the codec, because `.describe()` and `.meta()` clone a codec and
 * keep its definition: `sqliteJson(Profile).describe("…")` is still trusted. This is not exported to adopters. A
 * codec an adopter writes is a function the kit has not read.
 */

const trusted = new WeakSet<object>();

/** Register a kit codec whose decode keeps every value where the wire side has it, and return it unchanged. */
export function trustDecode<S extends z.ZodType>(codec: S): S {
  const decode = (codec as unknown as { def: { transform?: unknown } }).def.transform;
  if (typeof decode === "function") trusted.add(decode);
  return codec;
}

/** Whether a codec's decode is one {@link trustDecode} registered. */
export function isTrustedDecode(decode: unknown): boolean {
  return typeof decode === "function" && trusted.has(decode);
}
