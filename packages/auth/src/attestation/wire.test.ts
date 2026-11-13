// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { decodeAttestation, encodeAttestation, requestBinding } from "./wire";

const PRESENTED = { platform: "ios", challenge: "c".repeat(43), assertion: "AAAA", keyId: "key-1" } as const;

describe("the x-pithy-attestation header", () => {
  test("round-trips what a client encodes", () => {
    expect(decodeAttestation(encodeAttestation(PRESENTED))).toEqual({ ok: true, value: PRESENTED });
  });

  test("is unpadded base64url over JSON, so it survives every proxy unquoted", () => {
    const header = encodeAttestation(PRESENTED);
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual(PRESENTED);
  });

  test("keyId is optional: Play Integrity has none", () => {
    const android = { platform: "android", challenge: "c".repeat(43), assertion: "token" } as const;
    expect(decodeAttestation(encodeAttestation(android))).toEqual({ ok: true, value: android });
  });

  test.each([
    ["not base64url", "not base64url!"],
    ["not JSON", Buffer.from("{nope").toString("base64url")],
    ["an unknown platform", Buffer.from(JSON.stringify({ ...PRESENTED, platform: "web" })).toString("base64url")],
    ["no assertion", Buffer.from(JSON.stringify({ platform: "ios", challenge: "c" })).toString("base64url")],
    ["an empty header", ""],
  ])("refuses %s, saying why", (_, header) => {
    const decoded = decodeAttestation(header);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason.length).toBeGreaterThan(0);
  });

  test("refuses a header longer than any real attestation", () => {
    const huge = encodeAttestation({ ...PRESENTED, assertion: "A".repeat(20_000) });
    expect(decodeAttestation(huge).ok).toBe(false);
  });
});

describe("requestBinding", () => {
  const body = new TextEncoder().encode('{"email":"a@example.com"}');

  test("is SHA-256 over the challenge and then the exact body bytes", async () => {
    const challenge = "c".repeat(43);
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode(challenge), ...body])),
    );
    expect(await requestBinding(challenge, body)).toEqual(expected);
  });

  test("changes with the body, so an attestation cannot be replayed onto another address", async () => {
    const other = new TextEncoder().encode('{"email":"b@example.com"}');
    expect(await requestBinding("c", body)).not.toEqual(await requestBinding("c", other));
  });

  test("changes with the challenge", async () => {
    expect(await requestBinding("c1", body)).not.toEqual(await requestBinding("c2", body));
  });
});
