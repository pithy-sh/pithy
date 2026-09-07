// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { GeneratedValueDrift, GeneratedValues } from "../capabilities/reconcile";
import { checkedWorker, cleanPlanFor, doctorHarness, planStub } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

const harness = doctorHarness();
const { baseOptions } = harness;

/**
 * What `pithy doctor` says about a generated binding value the kit would now write differently (#499).
 *
 * **The report is the whole feature.** Nothing rewrites the value — a `namespace_id` is a live budget's
 * identity, and the adopter's number may be the one they meant — so a line an adopter can read is the
 * entire remedy, and it lands on a project where every other check passes. That costs two gates in the
 * renderer, the same two `doctorDeclines.test.ts` pins for the neighboring finding, and both are here:
 * the Worker must not collapse to `healthy ✓`, and the health block must be pushed despite `ok`.
 */

/** A report over one Worker whose only interesting fact is what its generated values are. */
async function reportWith(generatedValues: GeneratedValues) {
  return buildDoctorReport(baseOptions({ buildPlan: planStub({ ...cleanPlanFor("api"), generatedValues }) }));
}

/** The limiter an older project holds, at the id its positional counter produced. */
const LIMITER: GeneratedValueDrift = {
  name: "AUTH_RATE_LIMITER",
  type: "ratelimit",
  field: "namespace_id",
  expected: "3093",
  actual: "1001",
  envs: ["dev", "staging", "prod"],
  pinnedReason: null,
};

const AGED: GeneratedValues = { state: "read", drift: [LIMITER], stalePins: [] };

const PINNED: GeneratedValues = {
  state: "read",
  drift: [{ ...LIMITER, pinnedReason: "our budget, tuned in 2025" }],
  stalePins: [],
};

describe("a differing generated value on an otherwise green project", () => {
  test("prints, rather than being collapsed into `healthy ✓`", async () => {
    const text = renderDoctorText(await reportWith(AGED), "/home/u");
    expect(text).toContain("Project health:");
    expect(text).not.toContain("api: healthy ✓");
  });

  test("names both numbers on one line, because the finding is the comparison", async () => {
    // One number sends the reader to a scaffold they would have to generate to learn the other, which is
    // the state this was found from.
    const text = renderDoctorText(await reportWith(AGED), "/home/u");
    expect(text).toContain("AUTH_RATE_LIMITER (ratelimit) namespace_id is 1001, and the kit writes 3093 today");
  });

  test("names the environments, says nothing rewrites it, and names the way to settle the line", async () => {
    const text = renderDoctorText(await reportWith(AGED), "/home/u");
    expect(text).toContain("env: dev, staging, prod. Yours may be deliberate, so nothing rewrites it.");
    expect(text).toContain("Change it, or name it in pinnedBindings to settle the line.");
  });

  test("offers no command, because there is none", async () => {
    // `pithy upgrade` writes a binding it finds missing and never rewrites one that is there. A line
    // naming a command that does not do this is worse than the line that names the two edits.
    const text = renderDoctorText(await reportWith(AGED), "/home/u");
    expect(text).not.toContain("run `pithy upgrade`");
    expect(text).not.toContain("run: pithy upgrade");
  });

  test("keeps the passing checks beside it, so it is not mistaken for a finding", async () => {
    const text = renderDoctorText(await reportWith(AGED), "/home/u");
    expect(text).toContain("all required bindings present ✓");
  });

  test("and does not fail the run", async () => {
    // The adopter's value may be the one they meant, and it is already deployed. A non-zero exit here
    // would make every CI run of every project scaffolded before the change red, forever, for a number
    // that works.
    const report = await reportWith(AGED);
    expect(report.project?.health.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a Worker with nothing to say still collapses, so nothing else grew a block", async () => {
    const text = renderDoctorText(await reportWith({ state: "read", drift: [], stalePins: [] }), "/home/u");
    expect(text).not.toContain("Project health:");
  });
});

describe("a pinned value", () => {
  test("prints the adopter's reason in place of the instruction", async () => {
    const text = renderDoctorText(await reportWith(PINNED), "/home/u");
    expect(text).toContain(
      "AUTH_RATE_LIMITER (ratelimit) namespace_id is 1001, pinned in pithy.config.ts — our budget, tuned in 2025",
    );
    expect(text).toContain("The kit writes 3093 today. env: dev, staging, prod.");
    expect(text).not.toContain("Change it, or name it in pinnedBindings");
  });

  test("is still reported, because a decision recorded is not a decision hidden", async () => {
    // A pin silences the instruction, never the fact. The next person reads both halves and the reason.
    const text = renderDoctorText(await reportWith(PINNED), "/home/u");
    expect(text).toContain("Project health:");
    expect(text).not.toContain("api: healthy ✓");
  });
});

describe("a pin nothing differs about", () => {
  test("says so, and stays green", async () => {
    const report = await reportWith({
      state: "read",
      drift: [],
      stalePins: [{ name: "AUTH_RATE_LIMITER", reason: "our budget, tuned in 2025" }],
    });
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("AUTH_RATE_LIMITER pinned in pithy.config.ts, and nothing about it differs");
    expect(text).toContain("Nothing is being kept for it. Delete the line, or fix the name.");
    expect(report.project?.health.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe("a declaration that will not parse", () => {
  test("is reported rather than swallowed", async () => {
    const report = await reportWith({ state: "invalid", problem: "AUTH_RATE_LIMITER: A reason is one line." });
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("`pinnedBindings` in pithy.config.ts cannot be read");
    expect(text).toContain("AUTH_RATE_LIMITER: A reason is one line.");
  });
});

describe("--json", () => {
  test("carries the whole comparison under the bindings check, both numbers included", async () => {
    // An agent reading this must not have to reconstruct either side from a fault name, and the `state`
    // is what stops "nothing pinned" and "the pins would not read" being one empty list.
    const report = await reportWith(AGED);
    const json = renderDoctorJson(report) as { project: { health: unknown } };
    expect(checkedWorker(report.project?.health).bindings.generatedValues).toEqual(AGED);
    expect(JSON.parse(JSON.stringify(json)).project.health.workers[0].bindings.generatedValues).toEqual(AGED);
  });
});
