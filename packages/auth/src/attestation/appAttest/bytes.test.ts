// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { equalBytes, sha256 } from "./bytes";

describe("equalBytes", () => {
  test("compares length and every byte", () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
  });
});

describe("sha256", () => {
  test("hashes the parts as one message", async () => {
    const whole = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc")));
    expect(await sha256(new TextEncoder().encode("a"), new TextEncoder().encode("bc"))).toEqual(whole);
  });
});
