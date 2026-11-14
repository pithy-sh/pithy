// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeAll, describe, expect, test } from "vitest";
import { type AttestedKey, appAttestAuthority } from "../../test-utils/appAttestDevice";
import { type AppAttestAssertionInput, verifyAppAttestAssertion } from "./assertion";
import { decodeBase64 } from "./base64";

const APP_ID = "ABCDE12345.com.example.app";
const CLIENT_DATA_HASH = new Uint8Array(32).fill(3);
const bytes = (base64: string) => decodeBase64(base64) as Uint8Array;

let key: AttestedKey;
let other: AttestedKey;

beforeAll(async () => {
  const authority = await appAttestAuthority();
  key = await authority.attest({ appId: APP_ID, clientDataHash: CLIENT_DATA_HASH });
  other = await authority.attest({ appId: APP_ID, clientDataHash: CLIENT_DATA_HASH });
});

async function input(overrides: Partial<AppAttestAssertionInput> & { counter?: number; signed?: number } = {}) {
  const { signed = 1, ...rest } = overrides;
  return {
    assertion: bytes(await key.assert({ appId: APP_ID, clientDataHash: CLIENT_DATA_HASH, counter: signed })),
    publicKey: key.publicKey,
    appId: APP_ID,
    clientDataHash: CLIENT_DATA_HASH,
    counter: 0,
    ...rest,
  };
}

describe("verifyAppAttestAssertion", () => {
  test("accepts the key's assertion over the client data hash, and answers its counter", async () => {
    expect(await verifyAppAttestAssertion(await input({ signed: 5, counter: 4 }))).toEqual({ ok: true, counter: 5 });
  });

  test("refuses a bad signature: another key's", async () => {
    expect(await verifyAppAttestAssertion(await input({ publicKey: other.publicKey }))).toMatchObject({
      ok: false,
      check: "signature",
    });
  });

  test("refuses a bad signature: over another request", async () => {
    expect(await verifyAppAttestAssertion(await input({ clientDataHash: new Uint8Array(32) }))).toMatchObject({
      ok: false,
      check: "signature",
    });
  });

  test("refuses a wrong rpIdHash", async () => {
    expect(await verifyAppAttestAssertion(await input({ appId: "ABCDE12345.com.example.other" }))).toMatchObject({
      ok: false,
      check: "rpIdHash",
    });
  });

  test("refuses a counter that does not increase: equal, and lower", async () => {
    expect(await verifyAppAttestAssertion(await input({ signed: 3, counter: 3 }))).toMatchObject({
      ok: false,
      check: "counter",
    });
    expect(await verifyAppAttestAssertion(await input({ signed: 2, counter: 3 }))).toMatchObject({
      ok: false,
      check: "counter",
    });
  });

  test.each([
    ["not CBOR", new Uint8Array([0xff])],
    ["a map with no signature", new Uint8Array([0xa0])],
  ])("refuses an assertion that is %s", async (_, assertion) => {
    expect(await verifyAppAttestAssertion(await input({ assertion }))).toMatchObject({ ok: false, check: "format" });
  });
});
