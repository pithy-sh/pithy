// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DevSecretValue } from "@pithy-sh/core/src/capability/devSecret";
import { describe, expect, test } from "vitest";
import { mintSecretValue } from "./mintValue";

describe("mintSecretValue", () => {
  test("mints a fresh value every call — one shipped literal would be every adopter's secret", () => {
    const values = new Set(Array.from({ length: 50 }, () => mintSecretValue("random")));
    expect(values.size).toBe(50);
  });

  test("carries 256 bits of entropy, url-safe and unpadded", () => {
    // 32 bytes base64url is 43 characters. Url-safe so the value survives a shell, a URL, and a
    // `.dev.vars` line with no quoting and no `=` that reads as a second separator.
    const value = mintSecretValue("random");
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("covers every declared kind, so a new one cannot ship unminted", () => {
    for (const kind of DevSecretValue.options) expect(mintSecretValue(kind).length).toBeGreaterThan(0);
  });
});
