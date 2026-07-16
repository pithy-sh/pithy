import { describe, expect, test } from "vitest";
import { computeSha256 } from "./sha256";

describe("computeSha256", () => {
  test("hashes the empty input to the known SHA-256 constant", async () => {
    const hash = await computeSha256(new TextEncoder().encode(""));
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("hashes 'abc' to the known SHA-256 constant", async () => {
    const hash = await computeSha256(new TextEncoder().encode("abc"));
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("accepts a raw ArrayBuffer and matches the Uint8Array result", async () => {
    const view = new TextEncoder().encode("abc");
    const buffer = view.buffer.slice(0) as ArrayBuffer;
    const fromBuffer = await computeSha256(buffer);
    expect(fromBuffer).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("emits exactly 64 lowercase-hex characters", async () => {
    const hash = await computeSha256(new TextEncoder().encode("pithy"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
