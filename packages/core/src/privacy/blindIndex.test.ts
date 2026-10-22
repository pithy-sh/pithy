// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { blindIndexValue, blindIndexVersion } from "./blindIndex";

/**
 * **The version a blind index carries (#390).** The stale count and the re-index read an index's version off its
 * `<version>:` prefix, so a value that is not one must read as `null`, never as some version.
 */

function keySet(): EncryptionConfig {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return { currentVersion: "12", versions: { "12": btoa(binary) }, lastRotatedAt: "2026-09-01T00:00:00.000Z" };
}

describe("blindIndexVersion", () => {
  test("reads the version an index was written under, past nine", async () => {
    expect(blindIndexVersion(await blindIndexValue(keySet(), 12, "exact", "a@example.com"))).toBe(12);
    expect(blindIndexVersion("3:abc")).toBe(3);
  });

  test("is null for a value with no version prefix", () => {
    for (const value of ["", "abc", ":abc", "v3:abc", "-1:abc", "3abc", " 3:abc"]) {
      expect(blindIndexVersion(value)).toBeNull();
    }
  });
});
