// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { decodeBase64, maxEncodedLength } from "./encoding";

/** Encode bytes the way a client would, so the test is a round trip rather than a fixed string. */
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("submission attachment decoding", () => {
  test("bytes survive the round trip exactly", () => {
    expect(decodeBase64(encode(PNG_HEADER), { maxBytes: 1024 })).toEqual(PNG_HEADER);
  });

  test("every byte value round-trips, not just printable ones", () => {
    // A screenshot is binary, so the interesting range is the whole one. `String.fromCharCode` over a
    // byte array is the classic place a naive implementation mangles anything over 0x7f.
    const all = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) all[index] = index;
    expect(decodeBase64(encode(all), { maxBytes: 1024 })).toEqual(all);
  });

  test("the URL-safe alphabet decodes to the same bytes", () => {
    // A client whose platform encoder produces base64url has not made a mistake worth a 400. These
    // bytes are chosen because they are the ones whose standard encoding contains both characters the
    // two alphabets differ on — a test using ASCII would pass without exercising the substitution.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const standard = encode(bytes);
    expect(standard).toContain("+");
    expect(standard).toContain("/");
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeBase64(urlSafe, { maxBytes: 1024 })).toEqual(bytes);
  });

  test("an empty payload is an empty file, not an error", () => {
    // Zero bytes is a legitimate thing to attach — an empty log — and a decoder that threw would make
    // it a 400 that says nothing useful.
    expect(decodeBase64("", { maxBytes: 1024 })).toEqual(new Uint8Array(0));
  });

  test("something that is not base64 is a validation failure, not a crash", () => {
    let raised: unknown;
    try {
      decodeBase64("not base64 at all!!", { maxBytes: 1024 });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(PithyError);
    expect((raised as PithyError).payload.code).toBe("validation/invalid_input");
  });

  test("an oversize payload is refused before it is decoded", () => {
    // The check is on the encoded length precisely because `atob` materialises the whole result: a
    // post-hoc size check has already been allocated the memory it meant to refuse.
    const huge = "A".repeat(maxEncodedLength(16) + 1);
    let raised: unknown;
    try {
      decodeBase64(huge, { maxBytes: 16 });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(PithyError);
    expect((raised as PithyError).payload.code).toBe("validation/invalid_input");
    // The bound is named in the internal detail and never in the public message — but it must be the
    // *configured* number an operator can act on, not the derived character count.
    expect((raised as PithyError).payload.detail).toContain("16 byte bound");
  });

  test("a payload exactly at the bound decodes", () => {
    // The slack in `maxEncodedLength` exists so the boundary case is an acceptance rather than an
    // off-by-four refusal of a file the adopter's config allows.
    const exact = new Uint8Array(16).fill(0x41);
    expect(decodeBase64(encode(exact), { maxBytes: 16 })).toHaveLength(16);
  });
});
