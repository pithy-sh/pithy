// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { RootImportsCheck } from "../doctor/rootImports";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Root imports:` block, as `pithy doctor` prints it. What the check establishes is
 * `doctor/rootImports.test.ts`'s; this is what the report does with it.
 */

const { baseOptions, healthyOptions } = doctorHarness();

const SENTENCE =
  'vitest.workers.config.ts imports @pithy-sh/secrets, which the project root does not resolve. Add "@pithy-sh/secrets": "^0.6.8" to devDependencies in the root package.json.';

const finding: RootImportsCheck = {
  state: "unresolved",
  unresolved: [
    {
      file: "vitest.workers.config.ts",
      package: "@pithy-sh/secrets",
      declared: false,
      line: '"@pithy-sh/secrets": "^0.6.8"',
    },
  ],
};

describe("the Root imports: block", () => {
  test("names the package, the config and the line to add, then the remedy", async () => {
    const report = await buildDoctorReport(baseOptions({ checkRootImports: async () => finding }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Root imports:");
    expect(text).toContain(SENTENCE);
    expect(text).toContain("Then run your package manager's install at the project root.");
  });

  test("prints in the terse report and never gates the exit", async () => {
    const report = await buildDoctorReport(healthyOptions({ checkRootImports: async () => finding }));
    expect(renderDoctorText(report, "/home/u")).toContain("Root imports:");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("says nothing when the root resolves every import", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkRootImports: async () => ({ state: "ok", unresolved: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Root imports:");
  });

  test("a check that throws says could-not-check, and still never gates the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkRootImports: async () => {
          throw new Error("Unexpected token } in JSON");
        },
      }),
    );
    expect(report.rootImports).toEqual({ state: "could-not-check", unresolved: [] });
    const payload = renderDoctorJson(report) as unknown as { rootImports: { findings: string[] } };
    expect(payload.rootImports.findings).toEqual([
      "Could not check what vitest.workers.config.ts imports against the project root.",
    ]);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("carries each import and its sentence in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkRootImports: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as {
      rootImports: RootImportsCheck & { findings: string[] };
    };
    expect(payload.rootImports.state).toBe("unresolved");
    expect(payload.rootImports.unresolved).toEqual([{ ...finding.unresolved[0], detail: SENTENCE, fix: null }]);
    expect(payload.rootImports.findings).toEqual([SENTENCE]);
  });
});
