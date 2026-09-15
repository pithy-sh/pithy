// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { TurnstileSitekeysCheck } from "../doctor/turnstileSitekeys";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Turnstile:` block, as `pithy doctor` prints it (#590). What the check establishes is
 * `doctor/turnstileSitekeys.test.ts`'s; this is what the report does with it.
 */

const harness = doctorHarness();
const { baseOptions } = harness;

const finding: TurnstileSitekeysCheck = {
  state: "findings",
  stranded: [
    { worker: "board", name: "TURNSTILE_SITEKEY_VISIBLE", environment: "prod", file: "/p/apps/board/wrangler.jsonc" },
  ],
  unrendered: [
    { worker: "board", environment: "staging", slot: true },
    { worker: "board", environment: "prod", slot: true },
    { worker: "board", environment: "live", slot: false },
  ],
};

describe("the Turnstile: block", () => {
  test("names the blocked environments, the stranded var, and what to run", async () => {
    const report = await buildDoctorReport(baseOptions({ checkTurnstileSitekeys: async () => finding }));
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("Turnstile:");
    expect(text).toContain("board: no widget renders in staging and prod");
    expect(text).toContain("pithy turnstile provision --worker board, then redeploy.");
    expect(text).toContain("board: live has no sitekey.");
    expect(text).toContain("/p/apps/board/wrangler.jsonc: TURNSTILE_SITEKEY_VISIBLE (prod).");
  });

  test("reports and never gates the exit", async () => {
    const report = await buildDoctorReport(baseOptions({ checkTurnstileSitekeys: async () => finding }));
    expect(doctorExitCode(report)).toBe(0);
  });

  test("says nothing when every widget renders and nothing is stranded", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkTurnstileSitekeys: async () => ({ state: "ok", stranded: [], unrendered: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Turnstile:");
  });

  test("carries both lists and the report's own sentences in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkTurnstileSitekeys: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as {
      turnstileSitekeys: TurnstileSitekeysCheck & { detail: string[] };
    };

    expect(payload.turnstileSitekeys.stranded).toEqual(finding.stranded);
    expect(payload.turnstileSitekeys.unrendered).toEqual(finding.unrendered);
    expect(payload.turnstileSitekeys.detail).toHaveLength(3);
  });
});
