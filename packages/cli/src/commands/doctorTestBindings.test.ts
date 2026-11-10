// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { TestBindingsCheck } from "../doctor/testBindings";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Workers tests:` block, as `pithy doctor` prints it. What the check establishes is
 * `doctor/testBindings.test.ts`'s; this is what the report does with it.
 */

const { baseOptions, healthyOptions } = doctorHarness();

const finding: TestBindingsCheck = {
  state: "missing",
  missing: [
    {
      capability: "secrets",
      workers: ["api"],
      bindings: ["SECRETS", "SECRETS_ENCRYPTION_KEYS"],
      fix: "pithy add secrets --worker api",
    },
  ],
};

describe("the Workers tests: block", () => {
  test("names the capability, its Workers and the missing bindings, then the remedy", async () => {
    const report = await buildDoctorReport(baseOptions({ checkTestBindings: async () => finding }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Workers tests:");
    expect(text).toContain("secrets (api): SECRETS, SECRETS_ENCRYPTION_KEYS missing from vitest.workers.config.ts.");
    expect(text).toContain("Run pithy add <capability> again to write them, or add them by hand.");
  });

  test("hands the check the Workers this report resolved", async () => {
    let seen: string[] = [];
    await buildDoctorReport(
      baseOptions({
        checkTestBindings: async ({ workers }) => {
          seen = workers.map((worker) => worker.name);
          return { state: "ok", missing: [] };
        },
      }),
    );
    expect(seen).toEqual(["api"]);
  });

  test("prints in the terse report and never gates the exit", async () => {
    const report = await buildDoctorReport(healthyOptions({ checkTestBindings: async () => finding }));
    expect(renderDoctorText(report, "/home/u")).toContain("Workers tests:");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("says nothing when the config provides every one", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkTestBindings: async () => ({ state: "ok", missing: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Workers tests:");
  });

  test("a check that throws says could-not-check, never null", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkTestBindings: async () => {
          throw new Error("EACCES: permission denied, open 'vitest.workers.config.ts'");
        },
      }),
    );
    expect(report.testBindings).toEqual({ state: "could-not-check", missing: [] });
    const payload = renderDoctorJson(report) as unknown as { testBindings: { state: string; findings: string[] } };
    expect(payload.testBindings).toMatchObject({ state: "could-not-check", missing: [] });
    expect(payload.testBindings.findings).toEqual([
      "Could not check vitest.workers.config.ts against the composed capabilities' test bindings.",
    ]);
    expect(renderDoctorText(report, "/home/u")).not.toContain("Workers tests:");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("carries the findings and their sentences in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkTestBindings: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as {
      testBindings: TestBindingsCheck & { findings: string[] };
    };
    expect(payload.testBindings.state).toBe("missing");
    expect(payload.testBindings.missing).toEqual([
      {
        ...finding.missing[0],
        detail: "secrets (api): SECRETS, SECRETS_ENCRYPTION_KEYS missing from vitest.workers.config.ts.",
      },
    ]);
    expect(payload.testBindings.findings).toEqual([
      "secrets (api): SECRETS, SECRETS_ENCRYPTION_KEYS missing from vitest.workers.config.ts.",
    ]);
  });
});
