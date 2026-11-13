// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { decodeBase64 } from "./base64";

describe("decodeBase64", () => {
  const bytes = new Uint8Array([0xce, 0x04, 0x98, 0xf5, 0xfb, 0xff]);

  test("reads standard padded base64, as Apple hands a key id over", () => {
    expect(decodeBase64("zgSY9fv/")).toEqual(bytes);
    expect(decodeBase64("zgQ=")).toEqual(new Uint8Array([0xce, 0x04]));
  });

  test("reads unpadded base64url, as a client may re-encode it", () => {
    expect(decodeBase64("zgSY9fv_")).toEqual(bytes);
    expect(decodeBase64("zgQ")).toEqual(new Uint8Array([0xce, 0x04]));
  });

  test.each([
    ["whitespace", "zgSY 9fv/"],
    ["mixed alphabets", "zg+Y9fv_"],
    ["padding in the middle", "zg==zgQ="],
    ["an impossible length", "zgSY9"],
    ["padding on a short group", "zgQ=="],
  ])("refuses %s", (_, value) => {
    expect(decodeBase64(value)).toBeUndefined();
  });
});
