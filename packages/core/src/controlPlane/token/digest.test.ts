import { describe, expect, test } from "vitest";
import { sha256Base64Url, timingSafeEqual } from "./digest";

describe("sha256Base64Url", () => {
  test("matches the published SHA-256 vectors, base64url-encoded", async () => {
    // NIST's `abc` vector and the empty-input vector, byte-for-byte.
    await expect(sha256Base64Url(new TextEncoder().encode("abc"))).resolves.toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
    await expect(sha256Base64Url(new Uint8Array())).resolves.toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  test("accepts an ArrayBuffer and a Uint8Array interchangeably", async () => {
    // A Worker hands you `await request.arrayBuffer()`; a codec hands you bytes. Both must digest alike.
    const bytes = new TextEncoder().encode("abc");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(await sha256Base64Url(buffer)).toBe(await sha256Base64Url(bytes));
  });

  test("is 43 characters — the unpadded base64url width of 32 bytes", async () => {
    // Pinned because `bodySha256` in the claims is validated against exactly that width.
    expect((await sha256Base64Url(new TextEncoder().encode("anything"))).length).toBe(43);
  });

  test("a single flipped bit changes the digest", async () => {
    const a = await sha256Base64Url(new Uint8Array([0x00]));
    const b = await sha256Base64Url(new Uint8Array([0x01]));
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqual", () => {
  test("agrees with === on equal strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
    expect(
      timingSafeEqual("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0", "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"),
    ).toBe(true);
  });

  test("agrees with === across many random pairs, equal and unequal", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const random = (length: number): string => {
      let out = "";
      for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
      return out;
    };
    for (let i = 0; i < 500; i++) {
      const a = random(43);
      // Half the pairs are equal, half differ — and the differing ones differ at a random position.
      const b = i % 2 === 0 ? a : `${a.slice(0, i % 43)}${a[i % 43] === "A" ? "B" : "A"}${a.slice((i % 43) + 1)}`;
      expect(timingSafeEqual(a, b)).toBe(a === b);
    }
  });

  test("differing lengths are unequal, whatever the shared prefix", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual("a", "")).toBe(false);
  });

  test("a difference in the last position is caught — no early return short-circuits the scan", () => {
    const digest = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0";
    expect(timingSafeEqual(digest, `${digest.slice(0, -1)}1`)).toBe(false);
    expect(timingSafeEqual(digest, `X${digest.slice(1)}`)).toBe(false);
  });

  test("a trailing NUL does not read as equal to the shorter string", () => {
    // The length difference must be folded into the same accumulator. Reading past the end yields
    // zero, so a NUL overrun xors to zero and would pass if length were not accounted for on its own.
    expect(timingSafeEqual("abc", "abc\u0000")).toBe(false);
    expect(timingSafeEqual("abc\u0000", "abc")).toBe(false);
  });
});
