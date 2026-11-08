// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

/**
 * **Expo leaves the app's `tsconfig.json` as scaffolded.**
 *
 * On every start with typed routes off, Expo filters its typed-routes entries out of `include` and, when that
 * changes anything, writes the whole file back as plain JSON, comments gone. Its TypeScript check does the same to a
 * file with no `extends`. The template turns typed routes on nowhere, so it must be a file both leave alone. This runs
 * Expo's own rules, read the way Expo reads the file, so an Expo upgrade that changes one fails here rather than in an
 * adopter's first `pithy dev`.
 */

/** Expo's tsconfig rules, from the `@expo/cli` the installed `expo` runs. */
interface TsconfigRules {
  getTSConfigRemoveUpdates(tsConfig: unknown): { updates: Set<string> };
  getTSConfigUpdates(tsConfig: unknown): { updates: Set<string> };
}

/** Expo's JSON reader, which parses `tsconfig.json` as JSON5 the way Expo does before applying the rules. */
interface JsonFile {
  default: { read(path: string, options: { json5: boolean }): Record<string, unknown> };
}

/** The installed Expo's rules and the template as Expo reads it. */
function underExpo(): { rules: TsconfigRules; tsConfig: () => Record<string, unknown> } {
  const fromExpo = createRequire(createRequire(import.meta.url).resolve("expo/package.json"));
  const fromCli = createRequire(fromExpo.resolve("@expo/cli/package.json"));
  const rules = fromCli("@expo/cli/build/src/start/server/type-generation/tsconfig") as TsconfigRules;
  const jsonFile = fromCli("@expo/json-file") as JsonFile;
  return { rules, tsConfig: () => jsonFile.default.read(join(TEMPLATE_DIR, "tsconfig.json"), { json5: true }) };
}

describe("the template tsconfig.json under Expo", () => {
  test("Expo's typed-routes cleanup finds nothing to change, so it never rewrites the file", () => {
    const { rules, tsConfig } = underExpo();
    expect([...rules.getTSConfigRemoveUpdates(tsConfig()).updates]).toEqual([]);
  });

  test("extends Expo's base, so Expo's TypeScript check finds nothing to add", () => {
    expect(underExpo().tsConfig().extends).toBe("expo/tsconfig.base");
  });

  test("turning typed routes on is what makes Expo add its entries and rewrite it", () => {
    const { rules, tsConfig } = underExpo();
    expect([...rules.getTSConfigUpdates(tsConfig()).updates]).toEqual(["include"]);
  });
});
