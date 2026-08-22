// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  PADDLE_DEFAULT_FRESHNESS_SECONDS,
  PADDLE_SIGNATURE_HEADER,
  signPaddleBody,
  verifyPaddleSignature,
} from "./signature";

/**
 * Paddle's scheme, exercised for real: every body here is signed with a key this file holds, and every
 * refusal is a signature this file constructed on purpose.
 *
 * Nothing is stubbed. A test that asserted `verifyPaddleSignature` "would" refuse a forgery is the shape
 * pithy-sh/pithy#326 catalogs — a gate structurally incapable of failing. So each refusal below builds
 * the exact bytes an attacker would send and watches the verifier throw on them.
 */

const SECRET = "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_abcdefghijklmnop";
const BODY = '{"event_id":"evt_01","event_type":"transaction.completed","occurred_at":"2026-08-12T09:00:00Z"}';
const NOW = new Date("2026-08-12T09:00:10Z");

/** The header Paddle would send for these bytes at this moment. */
async function header(body: string, at: Date, secret = SECRET): Promise<string> {
  const ts = Math.floor(at.getTime() / 1000);
  return `ts=${ts};h1=${await signPaddleBody(ts, body, secret)}`;
}

/** Run the verifier and hand back the `PithyError` it threw, or fail loudly when it did not throw. */
async function refusal(body: string, value: string | null, now = NOW, tolerance?: number): Promise<PithyError> {
  try {
    await verifyPaddleSignature(body, value, { secret: SECRET, now, toleranceSeconds: tolerance });
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("verifyPaddleSignature", () => {
  test("accepts the header Paddle would send for these exact bytes", async () => {
    const signed = await header(BODY, new Date("2026-08-12T09:00:05Z"));
    await expect(
      verifyPaddleSignature(BODY, signed, { secret: SECRET, now: NOW, toleranceSeconds: undefined }),
    ).resolves.toBeUndefined();
  });

  test("the header name is the lower-case one Hono presents", () => {
    expect(PADDLE_SIGNATURE_HEADER).toBe("paddle-signature");
  });

  test("refuses a forged h1 — the whole point of the module", async () => {
    // A real timestamp, a real format, and a signature an attacker made up. This is the forgery, built
    // rather than described.
    const ts = Math.floor(NOW.getTime() / 1000);
    const forged = `ts=${ts};h1=${"a".repeat(64)}`;
    expect((await refusal(BODY, forged)).payload.code).toBe("payments/verification_failed");
  });

  test("refuses a signature minted under another secret", async () => {
    // The realistic forgery: an attacker who has captured a delivery and holds *a* signing secret, just
    // not this destination's. Same format, same timestamp, wrong key.
    const wrong = await header(BODY, NOW, "pdl_ntfset_someone_elses_destination_secret");
    expect((await refusal(BODY, wrong)).payload.code).toBe("payments/verification_failed");
  });

  test("refuses a signature minted over different bytes", async () => {
    // The tampering attack: an authentic signature lifted from one delivery and pasted onto a body whose
    // amount has been edited. The MAC covers the body, so it cannot survive the edit.
    const authentic = await header(BODY, NOW);
    const tampered = BODY.replace("transaction.completed", "transaction.canceled");
    expect(tampered).not.toBe(BODY);
    expect((await refusal(tampered, authentic)).payload.code).toBe("payments/verification_failed");
  });

  test("refuses a signature minted over the same bytes under a different timestamp", async () => {
    // The timestamp is *inside* the signed payload, which is what stops a captured signature being
    // re-dated to slip through the freshness window. Editing `ts` alone breaks the MAC.
    const authentic = await header(BODY, NOW);
    const redated = authentic.replace(/^ts=\d+/, `ts=${Math.floor(NOW.getTime() / 1000) + 1}`);
    expect(redated).not.toBe(authentic);
    expect((await refusal(BODY, redated)).payload.code).toBe("payments/verification_failed");
  });

  test("refuses an absent header", async () => {
    expect((await refusal(BODY, null)).payload.code).toBe("payments/verification_failed");
  });

  test("refuses every malformed header shape", async () => {
    const ts = Math.floor(NOW.getTime() / 1000);
    const good = await signPaddleBody(ts, BODY, SECRET);
    const malformed = [
      "",
      good, // a bare hex MAC — Lemon Squeezy's shape, not Paddle's
      `ts=${ts}`, // no h1
      `h1=${good}`, // no ts
      `ts=;h1=${good}`, // empty ts
      `ts=${ts};h1=`, // empty h1
      `ts=not-a-number;h1=${good}`,
      `ts=${ts},h1=${good}`, // Stripe's separator, which this scheme does not use
      `ts=${ts};h1=${good.slice(0, 62)}`, // 31 bytes: too short to be an HMAC-SHA256
      `ts=${ts};h1=${good}ff`, // 33 bytes: too long
      `ts=${ts};h1=${"z".repeat(64)}`, // not hex
    ];
    for (const value of malformed) {
      expect((await refusal(BODY, value)).payload.code, JSON.stringify(value)).toBe("payments/verification_failed");
    }
  });

  test("accepts more than one h1, because Paddle may list several during a rotation", async () => {
    // Documented behavior: a header may carry several `h1` values while a secret is being rotated. A
    // verifier that read only the first would drop every delivery for the length of the rotation.
    const ts = Math.floor(NOW.getTime() / 1000);
    const real = await signPaddleBody(ts, BODY, SECRET);
    await expect(
      verifyPaddleSignature(BODY, `ts=${ts};h1=${"a".repeat(64)};h1=${real}`, {
        secret: SECRET,
        now: NOW,
        toleranceSeconds: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  test("refuses a header listing more h1 values than a rotation could need", async () => {
    // Unbounded, this is free CPU for an attacker: every listed candidate costs an HMAC. Paddle lists two
    // during a rotation, so the cap is generous and finite.
    //
    // **The last candidate is the real signature**, and that is what makes this a gate rather than a
    // sentence. A version with the cap removed accepts this header — it verifies the padding, reaches the
    // genuine MAC, and passes — so the test fails the moment the cap goes. Written the obvious way, with
    // twelve forgeries, every candidate would fail on its own merits and the assertion would hold with or
    // without the cap: green, and structurally incapable of failing.
    const ts = Math.floor(NOW.getTime() / 1000);
    const real = await signPaddleBody(ts, BODY, SECRET);
    const padded = Array.from({ length: 11 }, () => `h1=${"a".repeat(64)}`).join(";");
    const refused = await refusal(BODY, `ts=${ts};${padded};h1=${real}`);
    expect(refused.payload.code).toBe("payments/verification_failed");
    // And refused as *unreadable* rather than as unmatched: the header is a shape this rail declines to
    // process, not a signature that failed to match.
    expect(refused.payload.detail).toContain("no Paddle-Signature header");
  });

  test("refuses a delivery older than the freshness window", async () => {
    const stale = await header(BODY, new Date(NOW.getTime() - 400_000));
    expect((await refusal(BODY, stale)).payload.code).toBe("payments/verification_failed");
  });

  test("refuses a delivery dated further ahead than the window allows", async () => {
    // Both directions. A far-future timestamp is either a broken clock or somebody trying to mint a
    // delivery that stays fresh forever.
    const ahead = await header(BODY, new Date(NOW.getTime() + 400_000));
    expect((await refusal(BODY, ahead)).payload.code).toBe("payments/verification_failed");
  });

  test("the window defaults to 300 seconds and is configurable", async () => {
    expect(PADDLE_DEFAULT_FRESHNESS_SECONDS).toBe(300);

    // 299 seconds old: inside the default, refused by a caller who asked for Paddle's own 5.
    const nearly = await header(BODY, new Date(NOW.getTime() - 299_000));
    await expect(
      verifyPaddleSignature(BODY, nearly, { secret: SECRET, now: NOW, toleranceSeconds: undefined }),
    ).resolves.toBeUndefined();
    expect((await refusal(BODY, nearly, NOW, 5)).payload.code).toBe("payments/verification_failed");
  });

  test("a refusal carries nothing the delivery supplied", async () => {
    // `detail` reaches an operator's log. The body, the candidate MAC and the secret must never be in it:
    // a log line is a place a forger would like to write, and a leaked secret has to be rotated.
    const forged = `ts=${Math.floor(NOW.getTime() / 1000)};h1=${"a".repeat(64)}`;
    const detail = (await refusal(BODY, forged)).payload.detail ?? "";
    expect(detail).not.toContain(SECRET);
    expect(detail).not.toContain("a".repeat(64));
    expect(detail).not.toContain("transaction.completed");
    expect(detail).toContain("Paddle");
  });
});

describe("signPaddleBody", () => {
  test("signs the timestamp, a colon, and the body — Paddle's payload, not Stripe's", async () => {
    // The two schemes differ in one character and the difference is the whole verification. Stripe joins
    // with a period; Paddle joins with a colon. Pinned by computing the same MAC independently here.
    const ts = 1_770_000_000;
    const mine = await signPaddleBody(ts, BODY, SECRET);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}:${BODY}`));
    const expected = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    expect(mine).toBe(expected);
    expect(mine).toHaveLength(64);

    // And the period-joined payload — Stripe's — produces something else, so the colon is load-bearing.
    const stripeShaped = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${BODY}`));
    const other = [...new Uint8Array(stripeShaped)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(mine).not.toBe(other);
  });
});
