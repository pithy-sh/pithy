// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const HERE = import.meta.dirname;
const SOURCES = readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.includes(".test."));

describe("App Attest verification", () => {
  test("is the whole set of sources this test reads", () => {
    expect(SOURCES.sort()).toEqual(
      [
        "assertion.ts",
        "attestation.ts",
        "authData.ts",
        "base64.ts",
        "bytes.ts",
        "cbor.ts",
        "der.ts",
        "keys.ts",
        "root.ts",
        "verifier.ts",
        "x509.ts",
      ].sort(),
    );
  });

  test.each(SOURCES)(
    "%s imports nothing but auth's own code, core and zod: no Node built-in, no dependency",
    (name) => {
      const source = readFileSync(join(HERE, name), "utf8");
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        expect(specifier.startsWith(".") || specifier.startsWith("@pithy-sh/core/src/"), specifier).toBe(true);
      }
    },
  );
});
