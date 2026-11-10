// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { BiomeIncludesCheck } from "../doctor/biomeIncludes";
import { doctorFailures } from "../doctor/failures";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Biome:` block, as `pithy doctor` prints it. What the check establishes is `doctor/biomeIncludes.test.ts`'s;
 * this is what the report does with it.
 */

const harness = doctorHarness();

const unanchored: BiomeIncludesCheck = {
  state: "unanchored",
  findings: [
    'biome.jsonc excludes "!**/.worktrees", which Biome also matches above the project, so in a pithy feature create worktree it excludes every file. Write "!.worktrees" instead.',
  ],
};

describe("the Biome: block", () => {
  test("names the line and the fix, fails the exit, and reports the check in --json", async () => {
    const report = await buildDoctorReport(harness.healthyOptions({ checkBiomeIncludes: async () => unanchored }));
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("Biome:");
    expect(text).toContain(unanchored.findings[0]);
    expect(text).toContain("Anchor each exclusion to the project");
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorJson(report).biomeIncludes).toEqual(unanchored);
    expect(doctorFailures(report)).toEqual([{ check: "biomeIncludes", detail: unanchored.findings[0], fix: null }]);
  });

  test("an anchored config says nothing and passes", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkBiomeIncludes: async () => ({ state: "ok", findings: [] }) }),
    );

    expect(renderDoctorText(report, "/home/u")).not.toContain("Biome:");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("outside a project there is nothing to read", async () => {
    const report = await buildDoctorReport(
      harness.baseOptions({ loadProject: undefined, checkBiomeIncludes: async () => unanchored }),
    );

    expect(renderDoctorJson(report).biomeIncludes).toBeNull();
  });
});
