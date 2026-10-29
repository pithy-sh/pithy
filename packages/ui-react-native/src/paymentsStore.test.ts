// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

const source = (path: string): string => readFileSync(join(TEMPLATE_DIR, path), "utf8");

/** Every import of `expo-iap` other than a type's, which is erased before Metro bundles anything. */
function runtimeImports(text: string): string[] {
  const imports = /from\s+["']expo-iap["']|import\(\s*["']expo-iap["']\s*\)|require\(\s*["']expo-iap["']\s*\)/;
  return text.split("\n").filter((line) => imports.test(line) && !/^import type /.test(line.trim()));
}

test("the store module Metro resolves on the web names expo-iap only as a type, and so does everything that imports it", () => {
  for (const path of ["src/payments-store.ts", "src/payments.tsx", "src/useStoreTransactions.ts"]) {
    expect(runtimeImports(source(path)), path).toEqual([]);
  }
});

test("the store module Metro resolves on a phone loads expo-iap lazily, on the first store call", () => {
  const native = runtimeImports(source("src/payments-store.native.ts"));
  expect(native).toHaveLength(1);
  expect(native[0]).toContain('import("expo-iap")');
});
