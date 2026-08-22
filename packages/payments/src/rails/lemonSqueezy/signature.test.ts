// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { signLemonSqueezyBody, verifyLemonSqueezySignature } from "./signature";

const SECRET = "ls_whsec_test_1";
const BODY = JSON.stringify({ meta: { event_name: "order_created" }, data: { id: "8801" } });

/** The code every refusal must carry — the guard maps it to a 401 before anything reaches the sender. */
async function refusalCode(promise: Promise<void>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof PithyError ? error.payload.code : "not a PithyError";
  }
}

describe("verifyLemonSqueezySignature", () => {
  test("accepts an HMAC-SHA256 of the exact received bytes under the signing secret", async () => {
    const signature = await signLemonSqueezyBody(BODY, SECRET);
    await expect(verifyLemonSqueezySignature(BODY, signature, SECRET)).resolves.toBeUndefined();
  });

  test("refuses a body altered by one byte after signing", async () => {
    // The whole point of signing the exact bytes. Re-serializing a parsed object would change them too,
    // which is why the guard hands the rail the string it read rather than an object.
    const signature = await signLemonSqueezyBody(BODY, SECRET);
    expect(await refusalCode(verifyLemonSqueezySignature(`${BODY} `, signature, SECRET))).toBe(
      "payments/verification_failed",
    );
  });

  test("refuses a signature minted with a different secret", async () => {
    const signature = await signLemonSqueezyBody(BODY, "ls_whsec_someone_else");
    expect(await refusalCode(verifyLemonSqueezySignature(BODY, signature, SECRET))).toBe(
      "payments/verification_failed",
    );
  });

  test("refuses an absent header", async () => {
    // A forger who sends no proof at all must land in the same place as one who sends a bad one.
    expect(await refusalCode(verifyLemonSqueezySignature(BODY, null, SECRET))).toBe("payments/verification_failed");
  });

  test("refuses a header that is not 32 bytes of hex", async () => {
    for (const candidate of ["", "not-hex", "abcd", `${await signLemonSqueezyBody(BODY, SECRET)}00`]) {
      expect(await refusalCode(verifyLemonSqueezySignature(BODY, candidate, SECRET))).toBe(
        "payments/verification_failed",
      );
    }
  });

  test("accepts the signature whatever case it arrives in", async () => {
    // Lemon Squeezy sends lower-case hex. Nothing promises it always will, and a case fold is free.
    const signature = await signLemonSqueezyBody(BODY, SECRET);
    await expect(verifyLemonSqueezySignature(BODY, signature.toUpperCase(), SECRET)).resolves.toBeUndefined();
  });

  test("a refusal names the rail and carries nothing the delivery sent", async () => {
    // `detail` reaches an operator's log. The secret, the body and the candidate signature must never.
    const signature = await signLemonSqueezyBody(BODY, "ls_whsec_someone_else");
    try {
      await verifyLemonSqueezySignature(BODY, signature, SECRET);
      throw new Error("expected a refusal");
    } catch (error) {
      const detail = error instanceof PithyError ? (error.payload.detail ?? "") : "";
      expect(detail).toContain("Lemon Squeezy");
      expect(detail).not.toContain(SECRET);
      expect(detail).not.toContain(signature);
      expect(detail).not.toContain("order_created");
    }
  });

  test("verification carries no clock and no window, because this scheme has neither", async () => {
    // Lemon Squeezy signs the bare body with no timestamp, so there is no freshness property to enforce
    // and none to pretend to. The absence is in the signature: there is no options bag to hand a
    // tolerance to, so no call site can configure a window this rail does not honor. Replay protection
    // rests entirely on the guard's `UNIQUE (rail, providerEventId)` insert.
    expect(verifyLemonSqueezySignature.length).toBe(3);
  });
});
