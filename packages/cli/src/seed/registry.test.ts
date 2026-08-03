// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { defineSeed } from "@pithy-sh/core/src/seed/seed";
import { describe, expect, test } from "vitest";
import { buildSeedPlan } from "./registry";

/** A capability carrying a set of seed sets, with no bindings or databases of its own. */
function seededCapability(name: string, seeds: ReturnType<typeof defineSeed>[]) {
  return defineCapability({ name, requiredBindings: [], seeds });
}

describe("buildSeedPlan", () => {
  test("no capabilities compose to an empty registry", () => {
    expect(buildSeedPlan([], { env: "dev", includeExamples: false })).toEqual({ sets: [], skippedByEnv: [] });
  });

  test("orders library-before-app by order, namespacing each set by capability", () => {
    const lib = seededCapability("leaderboard", [defineSeed({ name: "demo", order: 100, environments: ["dev"] })]);
    const app = seededCapability("app", [defineSeed({ name: "demo", order: 1000, environments: ["dev"] })]);

    const composed = buildSeedPlan([app, lib], { env: "dev", includeExamples: false });
    expect(composed.sets.map((s) => s.key)).toEqual(["0100_leaderboard_demo", "1000_app_demo"]);
    expect(composed.skippedByEnv).toEqual([]);
  });

  test("drops example sets unless includeExamples is set", () => {
    const cap = seededCapability("leaderboard", [
      defineSeed({ name: "demo", order: 100, environments: ["dev"], example: true }),
    ]);

    expect(buildSeedPlan([cap], { env: "dev", includeExamples: false }).sets).toEqual([]);
    expect(buildSeedPlan([cap], { env: "dev", includeExamples: true }).sets.map((s) => s.key)).toEqual([
      "0100_leaderboard_demo",
    ]);
  });

  test("reports a set disallowed for the requested env in skippedByEnv, not the runnable list", () => {
    const cap = seededCapability("leaderboard", [
      defineSeed({ name: "staging_only", order: 100, environments: ["staging"] }),
    ]);

    const composed = buildSeedPlan([cap], { env: "prod", includeExamples: false });
    expect(composed.sets).toEqual([]);
    expect(composed.skippedByEnv).toEqual(["0100_leaderboard_staging_only"]);
  });
});
