// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { VarStanzasCheck } from "../doctor/varStanzas";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Worker vars:` block, as `pithy doctor` prints it. What the check establishes is `doctor/varStanzas.test.ts`'s;
 * this is what the report does with it.
 */

const { baseOptions, healthyOptions } = doctorHarness();

const UNDECLARED = 'api: env.prod.vars has no FEED, which the top level sets. Add "FEED": "x".';
const DECLARED =
  'api: env.staging.vars has no READY_AFTER_MINUTES, which the Worker declares. Add "READY_AFTER_MINUTES": 15, or run pithy worker sync --worker api.';

const finding: VarStanzasCheck = {
  state: "faulty",
  findings: [
    { worker: "api", kind: "missing", stanza: "env.prod", name: "FEED", declared: false, line: '"FEED": "x"' },
    {
      worker: "api",
      kind: "missing",
      stanza: "env.staging",
      name: "READY_AFTER_MINUTES",
      declared: true,
      line: '"READY_AFTER_MINUTES": 15',
    },
  ],
};

describe("the Worker vars: block", () => {
  test("names each stanza and the line to add, then the remedy", async () => {
    const report = await buildDoctorReport(baseOptions({ checkVarStanzas: async () => finding }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Worker vars:");
    expect(text).toContain(UNDECLARED);
    expect(text).toContain(DECLARED);
    expect(text).toContain("env.<name>.vars replaces the top-level block");
  });

  test("prints in the terse report and never gates the exit", async () => {
    const report = await buildDoctorReport(healthyOptions({ checkVarStanzas: async () => finding }));
    expect(renderDoctorText(report, "/home/u")).toContain("Worker vars:");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("says nothing when every stanza carries every var", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkVarStanzas: async () => ({ state: "ok", findings: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Worker vars:");
  });

  test("a check that throws says could-not-check, and still never gates the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkVarStanzas: async () => {
          throw new Error("Unexpected token } in JSON");
        },
      }),
    );
    expect(report.varStanzas).toEqual({ state: "could-not-check", findings: [] });
    expect(doctorExitCode(report)).toBe(0);
  });

  test("carries each finding, its sentence and its fix in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkVarStanzas: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as {
      varStanzas: { state: string; vars: Record<string, unknown>[]; findings: string[] };
    };
    expect(payload.varStanzas.state).toBe("faulty");
    expect(payload.varStanzas.vars).toEqual([
      { ...finding.findings[0], detail: UNDECLARED, fix: null },
      { ...finding.findings[1], detail: DECLARED, fix: "pithy worker sync --worker api" },
    ]);
    expect(payload.varStanzas.findings).toEqual([UNDECLARED, DECLARED]);
  });
});
