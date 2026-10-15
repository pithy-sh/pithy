// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { readCallback } from "./callback";

const EXPECT = { state: "Nl4YN8C6V9uAe_qr7-m2fA", redirectUri: "http://127.0.0.1:27164/callback" };

/** The refusal `readCallback` threw, or a failure when it did not throw. */
function refusal(address: string): PithyError {
  try {
    readCallback(address, EXPECT);
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error(`readCallback accepted ${address}`);
}

describe("readCallback", () => {
  test("a landing address with the expected state yields its code", () => {
    expect(
      readCallback(
        `http://127.0.0.1:27164/callback?code=cfoac_abc.def&scope=user-details.read&state=${EXPECT.state}`,
        EXPECT,
      ),
    ).toEqual({ kind: "code", code: "cfoac_abc.def" });
  });

  test("tolerates what a paste brings with it: surrounding space and quotes", () => {
    expect(readCallback(`  "http://127.0.0.1:27164/callback?code=c1&state=${EXPECT.state}"\n`, EXPECT)).toEqual({
      kind: "code",
      code: "c1",
    });
  });

  test("an authorization error comes back as Cloudflare's own words, not as a code", () => {
    // Cloudflare redirects a refusal to the loopback address too — measured with `state=x`.
    expect(
      readCallback(
        `http://127.0.0.1:27164/callback?error=access_denied&error_description=The+user+denied&state=${EXPECT.state}`,
        EXPECT,
      ),
    ).toEqual({ kind: "error", error: "access_denied", description: "The user denied" });
  });

  test("a different state is refused, so a code from some other sign-in is never redeemed", () => {
    expect(refusal("http://127.0.0.1:27164/callback?code=c1&state=someone-elses").payload.message).toMatch(/state/i);
  });

  test("a different port or path is refused: it is not the address this sign-in sent", () => {
    expect(refusal(`http://127.0.0.1:9999/callback?code=c1&state=${EXPECT.state}`).payload.message).toMatch(/address/i);
    expect(refusal(`http://127.0.0.1:27164/other?code=c1&state=${EXPECT.state}`).payload.message).toMatch(/address/i);
  });

  test("an address with neither a code nor an error is refused, naming what is missing", () => {
    expect(refusal(`http://127.0.0.1:27164/callback?state=${EXPECT.state}`).payload.message).toMatch(/code/);
  });

  test("something that is not an address at all is refused rather than parsed loosely", () => {
    expect(refusal("cfoac_just-the-code").payload.message).toMatch(/address/i);
  });
});
