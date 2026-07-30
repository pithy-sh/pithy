// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../../error/pithyError";
import { base64UrlDecode, base64UrlEncode } from "./base64url";

describe("base64UrlEncode", () => {
  test("emits the url alphabet and no padding", () => {
    // Standard base64 of these bytes is `+/8=` — every character the url alphabet replaces, plus a pad.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(base64UrlEncode(new TextEncoder().encode("hello"))).toBe("aGVsbG8");
    expect(base64UrlEncode(new Uint8Array())).toBe("");
  });

  test("encodes a large array without spreading it into an argument list", () => {
    // The stack-overflow guard. `String.fromCharCode(...bytes)` dies somewhere around 100k arguments,
    // and a registered key or a request body is exactly the input that would find that edge. The bytes
    // vary rather than repeat, so a decoder that lost its place would not still round-trip.
    const large = new Uint8Array(500_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;

    const encoded = base64UrlEncode(large);
    expect(encoded.length).toBe(Math.ceil((500_000 * 4) / 3)); // unpadded base64 width

    // Compared by hand rather than with `toEqual`. Vitest's deep equality walks half a million elements
    // and prepares a diff for them, which took roughly eight seconds and blew the default timeout
    // whenever the suite ran under load — the assertion was the slow part, not the code under test. A
    // scan reporting the first mismatching index fails just as loudly and finishes in milliseconds.
    const decoded = base64UrlDecode(encoded);
    expect(decoded.length).toBe(large.length);
    let firstMismatch = -1;
    for (let i = 0; i < large.length; i++) {
      if (decoded[i] !== large[i]) {
        firstMismatch = i;
        break;
      }
    }
    expect(firstMismatch, "round-trip diverged at this byte index").toBe(-1);
  });
});

describe("base64UrlDecode", () => {
  test("round-trips every byte value, at every length remainder", () => {
    for (let length = 0; length < 64; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 7 + length) % 256;
      expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    }
  });

  test("decodes each unpadded remainder", () => {
    expect(base64UrlDecode("")).toEqual(new Uint8Array());
    expect(base64UrlDecode("QQ")).toEqual(new TextEncoder().encode("A"));
    expect(base64UrlDecode("QUI")).toEqual(new TextEncoder().encode("AB"));
    expect(base64UrlDecode("QUJD")).toEqual(new TextEncoder().encode("ABC"));
  });

  test("rejects standard-base64 characters rather than decoding them", () => {
    expect(() => base64UrlDecode("+w")).toThrow(PithyError);
    expect(() => base64UrlDecode("/w")).toThrow(PithyError);
  });

  test("rejects padding — JWS segments are unpadded, and one token must have one spelling", () => {
    expect(() => base64UrlDecode("QQ==")).toThrow(PithyError);
    expect(() => base64UrlDecode("QUI=")).toThrow(PithyError);
  });

  test("rejects an impossible length and any character outside the alphabet", () => {
    expect(() => base64UrlDecode("A")).toThrow(PithyError); // no base64 encoding is 1 mod 4 long
    expect(() => base64UrlDecode("QQ Q")).toThrow(PithyError);
    expect(() => base64UrlDecode("héllo")).toThrow(PithyError);
    expect(() => base64UrlDecode("QQ\n")).toThrow(PithyError);
  });

  test("the rejection is a control-plane credential failure, not a raw Error", () => {
    // The whole point of throwing here: a malformed segment renders as a 401 through the one handler,
    // never as a 500 with a stack trace.
    try {
      base64UrlDecode("!!!!");
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("controlplane/invalid_credential");
      expect((error as PithyError).payload.status).toBe(401);
    }
  });
});
