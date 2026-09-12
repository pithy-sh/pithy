// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { invitationDigest, mintInvitationToken } from "./token";

/**
 * The two properties a credential of this shape has to have: enough entropy that nobody guesses one,
 * and a stored form that is not the presented form.
 */

/** Unpadded base64url, the alphabet the accept link's path segment is written in. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("mintInvitationToken", () => {
  test("is 256 bits, url-safe, and unpadded", () => {
    const token = mintInvitationToken();
    expect(token).toMatch(BASE64URL);
    // 32 bytes is 43 unpadded base64 characters. Asserted as a length rather than as "long enough",
    // because the day somebody shortens the byte count this is the line that says what was lost.
    expect(token).toHaveLength(43);
  });

  test("never repeats", () => {
    const minted = new Set(Array.from({ length: 512 }, () => mintInvitationToken()));
    expect(minted.size).toBe(512);
  });
});

describe("invitationDigest", () => {
  test("is stable for one token and different for another", async () => {
    const token = mintInvitationToken();
    expect(await invitationDigest(token)).toBe(await invitationDigest(token));
    expect(await invitationDigest(token)).not.toBe(await invitationDigest(mintInvitationToken()));
  });

  test("does not contain the token it is taken of", async () => {
    // The whole point of the column. A digest that embedded its input would be an encoding, and the
    // row would hold a live credential under a name that says it does not.
    const token = mintInvitationToken();
    const digest = await invitationDigest(token);
    expect(digest).not.toContain(token);
    expect(token).not.toContain(digest);
  });

  test("is base64url, so it is safe in a query parameter and in a log line", async () => {
    expect(await invitationDigest("anything")).toMatch(BASE64URL);
  });

  test("matches the SHA-256 of the token's UTF-8 bytes", async () => {
    // Pinned against the primitive rather than against a fixture, so the assertion still means
    // something if the encoding of the input ever changes.
    const bytes = new TextEncoder().encode("ada@example.com");
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let binary = "";
    for (const byte of expected) binary += String.fromCharCode(byte);
    const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await invitationDigest("ada@example.com")).toBe(base64url);
  });
});
