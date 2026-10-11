// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { isShippedSource, isTestFile, readSource, sourcePaths } from "../ci/sourceFiles";
import { EnvironmentVariable } from "./cliSchema";
import { ENVIRONMENT_VARIABLES } from "./environment";

/**
 * **Every `PITHY_` variable the CLI reads is one `pithy schema` publishes (#697).**
 *
 * A variable an agent cannot discover is a setting it cannot use, and `PITHY_NONINTERACTIVE` was the one
 * this issue added — so the list is held to the source rather than to anybody's memory. The scan reads
 * every `"PITHY_…"` string literal and every `env.PITHY_…` read in shipped CLI source; the names below
 * are the ones that are not a setting a caller makes.
 */

const SRC = join(import.meta.dirname, "..");

/** `PITHY_` names in the source that are not the CLI's settings, and why. */
const NOT_SETTINGS: Record<string, string> = {
  PITHY_ALLOW_REAL_CONFIG_DIR: "A test-only escape hatch from the config-directory guard. Nothing ships setting it.",
  PITHY_DEPLOY_STAMP: "A var the CLI writes into a deployed Worker, read by the Worker rather than by the CLI.",
};

/** Every `"PITHY_…"` literal in the CLI's shipped source. */
function literalNames(): Set<string> {
  const found = new Set<string>();
  for (const path of sourcePaths(SRC, { keep: (name) => isShippedSource(name) && !isTestFile(name) })) {
    const text = readSource(path);
    if (text === null) continue;
    const code = blankComments(text);
    for (const match of code.matchAll(/["'`](PITHY_[A-Z][A-Z0-9_]*)["'`]/g)) found.add(match[1] as string);
    // And a property read, `process.env.PITHY_NO_UPDATE_NOTIFIER`, which names the variable with no literal.
    for (const match of code.matchAll(/\benv\.(PITHY_[A-Z][A-Z0-9_]*)\b/g)) found.add(match[1] as string);
  }
  return found;
}

describe("ENVIRONMENT_VARIABLES", () => {
  test("every entry is what `pithy schema` says one is, and named once", () => {
    for (const variable of ENVIRONMENT_VARIABLES) expect(EnvironmentVariable.parse(variable)).toEqual(variable);
    const names = ENVIRONMENT_VARIABLES.map((variable) => variable.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every PITHY_ variable the source reads is published", () => {
    const found = literalNames();
    // Anti-vacuous: a scan that stopped matching would pass over nothing.
    expect(found.size).toBeGreaterThan(5);
    const published = new Set(ENVIRONMENT_VARIABLES.map((variable) => variable.name));
    expect([...found].filter((name) => !published.has(name) && !(name in NOT_SETTINGS)).sort()).toEqual([]);
  });

  test("every exemption names a variable the source still holds", () => {
    const found = literalNames();
    for (const name of Object.keys(NOT_SETTINGS)) expect(found).toContain(name);
  });

  test("the Cloudflare overlay's own keys are published from its own list", () => {
    const published = new Set(ENVIRONMENT_VARIABLES.map((variable) => variable.name));
    for (const key of CLOUDFLARE_ENV_KEYS) expect(published).toContain(key);
  });
});
