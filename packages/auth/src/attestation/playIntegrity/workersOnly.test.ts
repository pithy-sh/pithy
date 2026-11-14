// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const HERE = import.meta.dirname;
const SOURCES = readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.includes(".test."));
const ALLOWED = ["./", "../", "@pithy-sh/core/src/", "@pithy-sh/secrets/src/"];

describe("Play Integrity verification", () => {
  test("is the whole set of sources this test reads", () => {
    expect(SOURCES.sort()).toEqual(["google.ts", "verdict.ts", "verifier.ts"]);
  });

  test.each(SOURCES)(
    "%s imports nothing but auth's own code, core, secrets and zod: no Node built-in, no Google SDK",
    (name) => {
      const source = readFileSync(join(HERE, name), "utf8");
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        expect(specifier === "zod" || ALLOWED.some((prefix) => specifier.startsWith(prefix)), specifier).toBe(true);
      }
    },
  );
});
