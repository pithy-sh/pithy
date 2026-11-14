// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { readAttestedAuthenticatorData, readAuthenticatorData } from "./authData";

const rpIdHash = new Uint8Array(32).fill(0xaa);
const aaguid = new TextEncoder().encode("appattestdevelop");
const credentialId = new Uint8Array(32).fill(0xcc);

function data(counter: number[], tail: number[] = []): Uint8Array {
  return new Uint8Array([...rpIdHash, 0x40, ...counter, ...tail]);
}

describe("readAuthenticatorData", () => {
  test("reads the rpIdHash and the big-endian counter", () => {
    expect(readAuthenticatorData(data([0, 0, 1, 2]))).toEqual({ rpIdHash, counter: 258 });
    expect(readAuthenticatorData(data([0xff, 0xff, 0xff, 0xff]))?.counter).toBe(4_294_967_295);
  });

  test("refuses a buffer too short for the header", () => {
    expect(readAuthenticatorData(new Uint8Array(36))).toBeUndefined();
  });

  test("reads a subarray where it sits, not from the start of its buffer", () => {
    const backing = new Uint8Array([9, 9, 9, ...data([0, 0, 0, 7])]);
    expect(readAuthenticatorData(backing.subarray(3))?.counter).toBe(7);
  });
});

describe("readAttestedAuthenticatorData", () => {
  test("reads the AAGUID and the credential id, and leaves what follows unread", () => {
    const bytes = data([0, 0, 0, 0], [...aaguid, 0, 32, ...credentialId, 0xa5, 0x01, 0x02]);
    expect(readAttestedAuthenticatorData(bytes)).toEqual({ rpIdHash, counter: 0, aaguid, credentialId });
  });

  test("refuses a credential id longer than what is left", () => {
    expect(readAttestedAuthenticatorData(data([0, 0, 0, 0], [...aaguid, 0, 33, ...credentialId]))).toBeUndefined();
  });

  test("refuses data with no attested credential at all", () => {
    expect(readAttestedAuthenticatorData(data([0, 0, 0, 0], [...aaguid]))).toBeUndefined();
  });
});
