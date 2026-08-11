// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Turning a base64 attachment back into bytes.
 *
 * Base64 rather than `multipart/form-data` for the submission route, and the reason is the contract
 * rather than the encoding: every other route in this capability declares what it accepts as a Zod
 * object over JSON, validated on the route line, and a multipart body is the one shape that cannot be.
 * The cost is a third more bytes on the wire, which is why `attachments.maxBytes` is documented as a
 * bound on the **decoded** size — the number that reaches R2 and the adopter's bill.
 */

/** How much larger a base64 string is than the bytes it encodes: four characters per three bytes. */
const BASE64_EXPANSION = 4 / 3;

/**
 * The largest base64 string worth decoding, derived from a decoded-byte bound.
 *
 * Checked **before** decoding, not after. `atob` materialises the whole result, so a client that sends
 * fifty megabytes of base64 has already been allocated fifty megabytes of Worker memory by the time a
 * post-hoc size check could refuse it — and the request that does that is the one an attacker sends.
 * A little slack for padding and any whitespace a client's encoder inserted.
 */
export function maxEncodedLength(maxBytes: number): number {
  return Math.ceil(maxBytes * BASE64_EXPANSION) + 4;
}

/**
 * Decode one base64 attachment payload.
 *
 * Accepts the URL-safe alphabet too: a client that reached for `base64url` because its platform's
 * default encoder produces it has not made a mistake worth a 400, and the two differ by two
 * characters. Anything that is not base64 at all is a `validation/invalid_input`, which is what the
 * route's own validator would have raised had the string been checkable there.
 */
export function decodeBase64(value: string, options: { maxBytes: number }): Uint8Array {
  if (value.length > maxEncodedLength(options.maxBytes)) {
    throw new ValidationError({
      message: "That attachment is too large.",
      action: `Attach a file under ${options.maxBytes} bytes.`,
      detail: `encoded attachment is ${value.length} characters, over the ${maxEncodedLength(options.maxBytes)} the ${options.maxBytes} byte bound allows`,
    });
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(normalized);
  } catch (cause) {
    throw new ValidationError(
      {
        message: "That attachment could not be read.",
        action: "Send the file's bytes as a base64 string.",
        detail: "attachment payload is not valid base64",
      },
      { cause },
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
