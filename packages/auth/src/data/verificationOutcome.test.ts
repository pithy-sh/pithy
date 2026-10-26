// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { describe, expect, test } from "vitest";
import { VerificationOutcome, verificationStateAt } from "./verificationOutcome";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

describe("verificationStateAt", () => {
  test("a used row is used, whatever its expiry says", () => {
    expect(verificationStateAt({ expiresAt: ago(1), usedAt: ago(60_000) }, NOW)).toBe("used");
    expect(verificationStateAt({ expiresAt: ahead(60_000), usedAt: ago(1) }, NOW)).toBe("used");
  });

  test("an unused row past its expiry is expired, and at the exact instant too", () => {
    expect(verificationStateAt({ expiresAt: ago(1), usedAt: null }, NOW)).toBe("expired");
    expect(verificationStateAt({ expiresAt: NOW, usedAt: null }, NOW)).toBe("expired");
  });

  test("an unused row before its expiry is pending", () => {
    expect(verificationStateAt({ expiresAt: ahead(1), usedAt: null }, NOW)).toBe("pending");
  });
});

describe("VerificationOutcome", () => {
  test("round-trips through its codecs: ms-epoch in, Date out, and back", () => {
    const value = {
      id: 1,
      verificationId: "v-1",
      type: "magic_link" as const,
      userId: null,
      emailJobId: "job-1",
      issuedAt: NOW,
      expiresAt: ahead(300_000),
      usedAt: null,
    };
    const stored = VerificationOutcome.encode(value);
    expect(stored.issuedAt).toBe(NOW.getTime());
    expect(VerificationOutcome.parse(stored)).toEqual(value);
    expect(SQLiteDate.encode(NOW)).toBe(NOW.getTime());
  });

  test("holds no column a token or an address could sit in", () => {
    expect(Object.keys(VerificationOutcome.shape).sort()).toEqual([
      "emailJobId",
      "expiresAt",
      "id",
      "issuedAt",
      "type",
      "usedAt",
      "userId",
      "verificationId",
    ]);
  });
});
