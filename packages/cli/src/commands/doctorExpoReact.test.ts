// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { ExpoReactCheck } from "../doctor/expoReact";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Expo apps:` block, as `pithy doctor` prints it. What the check establishes is `doctor/expoReact.test.ts`'s;
 * this is what the report does with it.
 */

const { baseOptions, healthyOptions } = doctorHarness();

const COMMAND = "bunx expo install react@19.2.3 react-dom@19.2.3 @types/react@~19.2.4";
const SENTENCE = `apps/app runs React 19.3.1 and React DOM 19.3.1 on React Native's 19.2.3 renderer, which takes React 19.2.3 exactly, so the app will not launch. In apps/app, run \`${COMMAND}\`.`;

const finding: ExpoReactCheck = {
  state: "mismatched",
  mismatched: [{ app: "apps/app", renderer: "19.2.3", react: "19.3.1", reactDom: "19.3.1", command: COMMAND }],
};

describe("the Expo apps: block", () => {
  test("names the app, the versions and the expo install that pins them, then the remedy", async () => {
    const report = await buildDoctorReport(baseOptions({ checkExpoReact: async () => finding }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Expo apps:");
    expect(text).toContain(SENTENCE);
    expect(text).toContain("pin react and react-dom to it exactly.");
  });

  test("prints in the terse report and never gates the exit", async () => {
    const report = await buildDoctorReport(healthyOptions({ checkExpoReact: async () => finding }));
    expect(renderDoctorText(report, "/home/u")).toContain("Expo apps:");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("says nothing about an app whose React matches its renderer", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkExpoReact: async () => ({ state: "ok", mismatched: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Expo apps:");
    expect((renderDoctorJson(report) as unknown as { expoReact: unknown }).expoReact).toEqual({
      state: "ok",
      mismatched: [],
      findings: [],
    });
  });

  test("a check that throws says could-not-check, and still never gates the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkExpoReact: async () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(report.expoReact).toEqual({ state: "could-not-check", mismatched: [] });
    const payload = renderDoctorJson(report) as unknown as { expoReact: { findings: string[] } };
    expect(payload.expoReact.findings).toEqual([
      "Could not check the Expo apps' React against their React Native renderer.",
    ]);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("carries each app, its command and its sentence in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkExpoReact: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as { expoReact: ExpoReactCheck & { findings: string[] } };
    expect(payload.expoReact.state).toBe("mismatched");
    expect(payload.expoReact.mismatched).toEqual([{ ...finding.mismatched[0], detail: SENTENCE, fix: null }]);
    expect(payload.expoReact.findings).toEqual([SENTENCE]);
  });
});
