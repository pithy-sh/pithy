// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { SelfBindingCheck } from "../doctor/selfBinding";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

const harness = doctorHarness();
const { healthyOptions } = harness;

/**
 * What `pithy doctor` says about a self-administering project whose stanza binds no `SELF` (#616).
 *
 * The fault is invisible until production: a Worker fetching its own hostname loops back through the edge
 * and hangs until Cloudflare answers 522, and every dashboard between the two reads that as somebody
 * else's outage. It is established from the checkout alone — the root config declares self-administration,
 * the stanza it deploys from has no binding — so it fails the exit, and it lands on a project where every
 * other check passes, which is what makes the two renderer gates here worth pinning.
 */
async function reportWith(selfBinding: SelfBindingCheck) {
  return buildDoctorReport(healthyOptions({ checkSelfBinding: async () => selfBinding }));
}

const UNBOUND: SelfBindingCheck = {
  state: "unbound",
  declared: true,
  missing: [
    { worker: "board", env: "staging" },
    { worker: "board", env: "prod" },
  ],
};

describe("a self-administering project with an unbound stanza", () => {
  test("prints, rather than being collapsed into the terse report", async () => {
    const text = renderDoctorText(await reportWith(UNBOUND), "/home/u");
    expect(text).toContain("Self binding:");
  });

  test("names each stanza, and says what the binding is for", async () => {
    const text = renderDoctorText(await reportWith(UNBOUND), "/home/u");
    expect(text).toContain("staging binds no SELF");
    expect(text).toContain("prod binds no SELF");
    expect(text).toContain("a Worker cannot fetch its own hostname");
  });

  test("names the command that writes it", async () => {
    const text = renderDoctorText(await reportWith(UNBOUND), "/home/u");
    expect(text).toContain("pithy provision --env");
  });

  /** The consequence is a timeout in production that nobody will read as a configuration fault. */
  test("fails the run", async () => {
    expect(doctorExitCode(await reportWith(UNBOUND))).toBe(1);
  });

  test("carries the finding into --json, sentence and all", async () => {
    const payload = renderDoctorJson(await reportWith(UNBOUND)) as {
      selfBinding: { state: string; declared: boolean; missing: { worker: string; env: string; detail: string }[] };
    };
    expect(payload.selfBinding.state).toBe("unbound");
    expect(payload.selfBinding.declared).toBe(true);
    expect(payload.selfBinding.missing[0]).toEqual({
      worker: "board",
      env: "staging",
      detail: expect.stringContaining("SELF"),
    });
  });
});

describe("a project that never declared it", () => {
  const QUIET: SelfBindingCheck = { state: "ok", declared: false, missing: [] };

  test("gets no block, and a clean exit", async () => {
    const report = await reportWith(QUIET);
    expect(renderDoctorText(report, "/home/u")).not.toContain("Self binding:");
    expect(doctorExitCode(report)).toBe(0);
  });

  /**
   * The key is still there, carrying `declared: false` — a consumer must be able to tell a project with
   * the binding from one that never asked for it, and a dropped key reads as neither.
   */
  test("still answers in --json", async () => {
    const payload = renderDoctorJson(await reportWith(QUIET)) as { selfBinding: { declared: boolean } };
    expect(payload.selfBinding.declared).toBe(false);
  });
});

describe("a check that could not run", () => {
  test("establishes nothing, and never fails the exit", async () => {
    const report = await reportWith({ state: "could-not-check", declared: false, missing: [] });
    expect(doctorExitCode(report)).toBe(0);
    expect(renderDoctorText(report, "/home/u")).not.toContain("Self binding:");
  });
});
