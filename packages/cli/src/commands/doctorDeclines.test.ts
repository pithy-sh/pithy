// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { BindingDecline } from "../capabilities/reconcile";
import { cleanPlanFor, doctorHarness, planStub } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

const harness = doctorHarness();
const { baseOptions } = harness;

/**
 * What `pithy doctor` says about a declined optional binding (#440).
 *
 * **The report is half the feature.** An adopter who declines a binding and gets silence back is in the
 * state the issue was filed from one level up: the next person cannot tell "chosen" from "never heard of
 * it". So a decline earns a line whether or not every other check passed — which means two gates in the
 * renderer that nothing else in this repo needed, and both are pinned here.
 */

/** A report over one Worker whose only interesting fact is what it declines. */
async function reportWith(declines: BindingDecline[]) {
  return buildDoctorReport(
    baseOptions({
      buildPlan: planStub({ ...cleanPlanFor("api"), declinedBindings: { state: "read", declines } }),
    }),
  );
}

const HONORED: BindingDecline = {
  state: "honored",
  name: "SUPPORT_BUCKET",
  type: "r2",
  capability: "support",
  reason: "no R2 in this account yet",
  stillPresentIn: ["dev", "staging", "prod"],
};

describe("a decline on an otherwise green project", () => {
  test("prints, rather than being collapsed into `healthy ✓`", async () => {
    // Two gates make this line reachable, and either one missing makes the feature output nothing on
    // exactly the reports it exists for: the Worker must not collapse to one line, and the health block
    // must be pushed even though `ok` is true.
    const text = renderDoctorText(await reportWith([HONORED]), "/home/u");
    expect(text).toContain("Project health:");
    expect(text).not.toContain("api: healthy ✓");
    expect(text).toContain("SUPPORT_BUCKET (r2) declined in pithy.config.ts — no R2 in this account yet");
    expect(text).toContain("support takes its optional path. Still in wrangler.jsonc for dev, staging, prod.");
  });

  test("keeps the passing checks beside it, so the decline is not mistaken for a finding", async () => {
    const text = renderDoctorText(await reportWith([HONORED]), "/home/u");
    expect(text).toContain("all required bindings present ✓");
  });

  test("and does not fail the run", async () => {
    // An honored decline is a configuration, not a defect. A non-zero exit here would make every CI run
    // of a project that declines anything red forever — the shape of the bug, not its fix.
    const report = await reportWith([HONORED]);
    expect(report.project?.health.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a Worker declining nothing still collapses, so nothing else grew a block", async () => {
    // The anti-regression for the gate above: it must widen the report for a decline and for nothing
    // else. Every green project in the world is this case.
    const text = renderDoctorText(await reportWith([]), "/home/u");
    expect(text).not.toContain("Project health:");
  });
});

describe("a decline that cannot be honored", () => {
  test("a required binding names the capability that requires it, and fails the run", async () => {
    const report = await reportWith([
      { state: "required", name: "DB", type: "d1", capability: "auth", reason: "using our own" },
    ]);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("DB (d1) declined in pithy.config.ts, and auth requires it");
    expect(text).toContain("A required binding is never left out. Remove the line.");
    expect(report.project?.health.ok).toBe(false);
    expect(doctorExitCode(report)).not.toBe(0);
  });

  test("a Workflow says what absent actually means, and names the command", async () => {
    const report = await reportWith([
      { state: "undeclinable", name: "SUPPORT_CLASSIFY", type: "workflow", capability: "support", reason: "no ai" },
    ]);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("SUPPORT_CLASSIFY (workflow) declined in pithy.config.ts, and this kind cannot be declined");
    expect(text).toContain("Absent means not provisioned. Run `pithy support provision`, or remove the line.");
    expect(report.project?.health.ok).toBe(false);
  });

  test("a Durable Object gets the reason that is true of it, and no command that does not exist", async () => {
    // It said "Absent means not provisioned. Run `pithy multiplayer provision`" — wrong on both halves.
    // No capability exposes a Durable Object provision command, and the reason a DO is refused is the
    // write-once class migration tag, not provisioning. Only the first line was pinned, so the wrong
    // second line shipped green.
    const text = renderDoctorText(
      await reportWith([
        { state: "undeclinable", name: "ROOM", type: "durable_object", capability: "multiplayer", reason: "no rooms" },
      ]),
      "/home/u",
    );
    expect(text).toContain("ROOM (durable_object) declined in pithy.config.ts, and this kind cannot be declined");
    expect(text).toContain("written once and never revisited");
    expect(text).not.toContain("multiplayer provision");
    expect(text).toContain("Remove the line.");
  });

  test("a declaration that will not parse is reported rather than swallowed", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        buildPlan: planStub({
          ...cleanPlanFor("api"),
          declinedBindings: { state: "invalid", problem: "SUPPORT_BUCKET: A reason is one line." },
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("`declinedBindings` in pithy.config.ts cannot be read");
    expect(text).toContain("SUPPORT_BUCKET: A reason is one line.");
    expect(report.project?.health.ok).toBe(false);
  });
});

describe("a decline naming something nothing declares", () => {
  test("says so, offers both ways out, and does not fail the run", async () => {
    // `pithy remove <capability>` produces this state. Failing on it would create a red no command
    // could clear, which is why it is the one bad state that stays green.
    const report = await reportWith([{ state: "unrecognized", name: "GONE", reason: "removed the capability" }]);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("GONE declined in pithy.config.ts, and nothing here declares it");
    expect(text).toContain("Nothing is being left out for it. Delete the line, or fix the name.");
    expect(report.project?.health.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe("the label column", () => {
  test("only the first bindings line carries the label, across all three lists", async () => {
    // Three lists share the `bindings` label now. The `index === 0 && previousList.length === 0`
    // arithmetic that carried two of them does not extend to a third, so the renderer counts lines
    // written instead — and this is what says it counted right.
    const report = await buildDoctorReport(
      baseOptions({
        buildPlan: planStub({
          ...cleanPlanFor("api"),
          perCapability: [
            {
              name: "media",
              missingConfigKeys: [],
              missingEntryExports: [],
              missingBindings: [{ env: "prod", name: "MEDIA_BUCKET", type: "r2" }],
            },
          ],
          declinedBindings: { state: "read", declines: [HONORED] },
        }),
      }),
    );
    const bindingLines = renderDoctorText(report, "/home/u")
      .split("\n")
      .filter((line) => line.includes("MEDIA_BUCKET") || line.includes("SUPPORT_BUCKET"));
    expect(bindingLines.filter((line) => line.includes("bindings"))).toHaveLength(1);
    expect(bindingLines[0]).toContain("bindings");
    expect(bindingLines[0]).toContain("MEDIA_BUCKET");
  });
});

describe("--json", () => {
  test("carries the resolved declines under the Worker's bindings health", async () => {
    // A management client reads this. It must be able to tell an honored decline from a missing binding
    // without parsing the terminal text.
    const json = renderDoctorJson(await reportWith([HONORED]));
    const workers = (json as { project?: { health?: { workers?: unknown[] } } }).project?.health?.workers;
    // The path is asserted rather than assumed: `project.health` passes through with no projection, so a
    // future one that dropped this field would be invisible to a test reading only the whole document.
    expect(workers, "project.health.workers must be where a client reads binding health").toBeDefined();
    const serialized = JSON.stringify(workers);
    expect(serialized).toContain('"declinedBindings"');
    expect(serialized).toContain('"state":"honored"');
    expect(serialized).toContain('"stillPresentIn":["dev","staging","prod"]');
  });
});
