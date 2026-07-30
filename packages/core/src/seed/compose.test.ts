// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type Capability, defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { composeSeeds, MAX_SEED_ORDER } from "./compose";
import { defineSeed } from "./seed";

function cap(name: string, seeds: Capability["seeds"]): Capability {
  return defineCapability({ name, requiredBindings: [], seeds });
}

const lib = cap("corelib", [defineSeed({ name: "base", order: 10, environments: ["dev", "staging", "production"] })]);
const app = cap("app", [
  defineSeed({ name: "demo", order: 100, environments: ["dev", "staging"] }),
  defineSeed({ name: "sample", order: 100, environments: ["dev"], example: true }),
  defineSeed({ name: "stagingOnly", order: 90, environments: ["staging"] }),
]);

describe("composeSeeds", () => {
  test("orders library-before-app and namespaces the key", () => {
    const { sets } = composeSeeds([app, lib], { env: "dev", includeExamples: false });
    // corelib (order 10) sorts before app's demo (order 100), regardless of capability arg order.
    expect(sets.map((s) => s.key)).toEqual(["0010_corelib_base", "0100_app_demo"]);
    expect(sets[0]?.capability).toBe("corelib");
  });

  test("drops example sets unless includeExamples is on", () => {
    const off = composeSeeds([app], { env: "dev", includeExamples: false });
    expect(off.sets.map((s) => s.set.name)).not.toContain("sample");

    const on = composeSeeds([app], { env: "dev", includeExamples: true });
    expect(on.sets.map((s) => s.set.name)).toContain("sample");
  });

  test("filters by the env allowlist and reports skipped sets", () => {
    const { sets, skippedByEnv } = composeSeeds([app], { env: "production", includeExamples: false });
    // Neither demo (dev,staging) nor stagingOnly (staging) allows production; example is config-off.
    expect(sets).toEqual([]);
    expect(skippedByEnv).toContain("0100_app_demo");
    expect(skippedByEnv).toContain("0090_app_stagingOnly");
  });

  test("production is only ever seeded when a set lists it explicitly", () => {
    const { sets } = composeSeeds([lib], { env: "production", includeExamples: false });
    expect(sets.map((s) => s.set.name)).toEqual(["base"]);
  });

  test("throws on a duplicate set name within one capability", () => {
    const bad = cap("app", [
      defineSeed({ name: "dup", order: 1, environments: ["dev"] }),
      defineSeed({ name: "dup", order: 2, environments: ["dev"] }),
    ]);
    expect(() => composeSeeds([bad], { env: "dev", includeExamples: false })).toThrow(PithyError);
  });

  test("throws on an out-of-range order", () => {
    const bad = cap("app", [defineSeed({ name: "x", order: MAX_SEED_ORDER + 1, environments: ["dev"] })]);
    expect(() => composeSeeds([bad], { env: "dev", includeExamples: false })).toThrow(PithyError);
  });
});
