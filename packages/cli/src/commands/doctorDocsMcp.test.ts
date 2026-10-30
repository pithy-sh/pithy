// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DocsMcpCheck } from "../doctor/docsMcp";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `AI clients:` block, as `pithy doctor` prints it (#652). What the check establishes is
 * `doctor/docsMcp.test.ts`'s; this is what the report does with it.
 */

const harness = doctorHarness();
const { baseOptions, healthyOptions } = harness;

const finding: DocsMcpCheck = {
  state: "unconnected",
  findings: [
    "Cursor, nothing in /home/u/.cursor/mcp.json — pithy docs connect --client cursor",
    "Codex CLI, nothing in /home/u/.codex-work/config.toml — pithy docs connect --client codex",
  ],
  clients: [
    { client: "cursor", label: "Cursor", paths: ["/home/u/.cursor/mcp.json"] },
    { client: "codex", label: "Codex CLI", paths: ["/home/u/.codex-work/config.toml"] },
  ],
};

describe("the AI clients: block", () => {
  test("names each client and the command that connects it, then the one remedy line", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDocsMcp: async () => finding }));
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("AI clients:");
    expect(text).toContain("Cursor, nothing in /home/u/.cursor/mcp.json — pithy docs connect --client cursor");
    expect(text).toContain("Codex CLI, nothing in /home/u/.codex-work/config.toml — pithy docs connect --client codex");
    expect(text).toContain("Each line is one command. `pithy docs status` shows where each one would land.");
  });

  test("reports and never gates the exit", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDocsMcp: async () => finding }));
    expect(doctorExitCode(report)).toBe(0);
  });

  /**
   * And it is not a term in the terse predicate either. An unconnected editor is not a fault in the
   * project, so it must not drag the paths, the capability table and the per-Worker health back into a
   * report that had nothing else to say — the block prints, and everything around it stays terse.
   */
  test("prints without making the rest of the report verbose", async () => {
    const report = await buildDoctorReport(healthyOptions({ checkDocsMcp: async () => finding }));
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("AI clients:");
    expect(text).toContain("Alias: installed");
    expect(text).not.toContain("Alias: installed (");
  });

  test("says nothing when every detected client already reads the docs", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkDocsMcp: async () => ({ state: "ok", findings: [], clients: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("AI clients:");
  });

  test("carries the findings and the report's own sentence in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDocsMcp: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as { docsMcp: DocsMcpCheck & { detail: string } };

    expect(payload.docsMcp.state).toBe("unconnected");
    expect(payload.docsMcp.findings).toEqual(finding.findings);
    expect(payload.docsMcp.detail).toBe("2 detected clients cannot read the Pithy docs.");
  });

  test("each client in --json names the files the check read for it, beside the command that connects it", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDocsMcp: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as {
      docsMcp: { clients: { client: string; paths: string[]; fix: string }[] };
    };

    expect(payload.docsMcp.clients).toEqual([
      {
        client: "cursor",
        label: "Cursor",
        paths: ["/home/u/.cursor/mcp.json"],
        fix: "pithy docs connect --client cursor",
      },
      {
        client: "codex",
        label: "Codex CLI",
        paths: ["/home/u/.codex-work/config.toml"],
        fix: "pithy docs connect --client codex",
      },
    ]);
  });

  test("outside a project there is nothing to report, and the key says so rather than passing", async () => {
    const report = await buildDoctorReport(baseOptions({ loadProject: undefined }));
    const payload = renderDoctorJson(report) as unknown as { docsMcp: unknown };

    expect(payload.docsMcp).toBeNull();
  });
});
