// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DuplicateCapabilitiesCheck } from "../doctor/duplicateCapabilities";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Capabilities declared twice:` block, as `pithy doctor` prints it. What the check establishes is
 * `doctor/duplicateCapabilities.test.ts`'s; this is what the report does with it.
 */

const { baseOptions, healthyOptions } = doctorHarness();

const SENTENCE = "@pithy-sh/secrets is a runtime dependency of the project root and of api.";

const finding: DuplicateCapabilitiesCheck = {
  state: "duplicated",
  duplicates: [{ package: "@pithy-sh/secrets", members: [".", "apps/api"] }],
};

describe("the Capabilities declared twice: block", () => {
  test("names the capability, the root and the Worker, then the remedy", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDuplicateCapabilities: async () => finding }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Capabilities declared twice:");
    expect(text).toContain(SENTENCE);
    expect(text).toContain(
      "Take each out of the root package.json's dependencies. A Worker declares what it composes.",
    );
  });

  test("prints in the terse report and never gates the exit", async () => {
    const report = await buildDoctorReport(healthyOptions({ checkDuplicateCapabilities: async () => finding }));
    expect(renderDoctorText(report, "/home/u")).toContain("Capabilities declared twice:");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("says nothing when no capability is declared twice", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkDuplicateCapabilities: async () => ({ state: "ok", duplicates: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Capabilities declared twice:");
  });

  test("a check that throws says could-not-check, and still never gates the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkDuplicateCapabilities: async () => {
          throw new Error("Unexpected token } in JSON");
        },
      }),
    );
    expect(report.duplicateCapabilities).toEqual({ state: "could-not-check", duplicates: [] });
    const payload = renderDoctorJson(report) as unknown as { duplicateCapabilities: { findings: string[] } };
    expect(payload.duplicateCapabilities.findings).toEqual([
      "Could not compare the capabilities the project root and its Workers declare.",
    ]);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("carries each capability and its sentence in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDuplicateCapabilities: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as {
      duplicateCapabilities: DuplicateCapabilitiesCheck & { findings: string[] };
    };
    expect(payload.duplicateCapabilities.state).toBe("duplicated");
    expect(payload.duplicateCapabilities.duplicates).toEqual([
      { ...finding.duplicates[0], detail: SENTENCE, fix: null },
    ]);
    expect(payload.duplicateCapabilities.findings).toEqual([SENTENCE]);
  });
});
