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
    { worker: "board", env: "staging", boundTo: null, deploysAs: "replay-board-staging" },
    // The other fault the same block carries: an entry that names a script this stanza does not deploy as.
    { worker: "board", env: "prod", boundTo: "replay-board-prod", deploysAs: "replay-prod-board" },
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
    expect(text).toContain("a Worker cannot fetch its own hostname");
    // The second fault reads differently on purpose: both script names, so an operator sees which edit
    // moved one and not the other.
    expect(text).toContain("prod binds SELF to replay-board-prod");
    expect(text).toContain("deploys as replay-prod-board");
  });

  /**
   * One line per environment, naming the command `--json` gives as each entry's `fix` (#697). Two Workers
   * missing in one environment are one provision, so one line; a production environment's provision needs a
   * person's `--confirm` phrase, so its line says so rather than handing over a command that stops at one.
   */
  test("names the command that writes it, once per environment, and the phrase production needs", async () => {
    const text = renderDoctorText(
      await reportWith({
        ...UNBOUND,
        missing: [
          ...UNBOUND.missing,
          { worker: "api", env: "staging", boundTo: null, deploysAs: "replay-api-staging" },
        ],
      }),
      "/home/u",
    );
    const commands = text.split("\n").filter((line) => line.includes("pithy provision"));
    expect(commands.map((line) => line.trim())).toEqual([
      "Run pithy provision --env staging --yes — it writes the binding with the stanza's own script name.",
      "`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix.",
    ]);
    expect(text).not.toContain("<name>");
  });

  test("an environment the project declares production gets the phrase line too", async () => {
    const text = renderDoctorText(
      await buildDoctorReport(
        healthyOptions({
          loadProject: async () => ({ name: "pithy-app", seed: { productionEnvironments: ["live"] } }),
          checkSelfBinding: async () => ({
            state: "unbound",
            declared: true,
            missing: [{ worker: "board", env: "live", boundTo: null, deploysAs: "replay-board-live" }],
          }),
        }),
      ),
      "/home/u",
    );
    expect(text).toContain(
      "`pithy provision --env live --yes` with its --confirm phrase, which only a person gives, runs against live, a production environment.",
    );
  });

  /** The consequence is a timeout in production that nobody will read as a configuration fault. */
  test("fails the run", async () => {
    expect(doctorExitCode(await reportWith(UNBOUND))).toBe(1);
  });

  test("carries the finding into --json, sentence and all", async () => {
    const payload = renderDoctorJson(await reportWith(UNBOUND)) as {
      selfBinding: {
        state: string;
        declared: boolean;
        missing: { worker: string; env: string; boundTo: string | null; deploysAs: string | null; detail: string }[];
      };
    };
    expect(payload.selfBinding.state).toBe("unbound");
    expect(payload.selfBinding.declared).toBe(true);
    expect(payload.selfBinding.missing[0]).toEqual({
      worker: "board",
      env: "staging",
      boundTo: null,
      deploysAs: "replay-board-staging",
      detail: expect.stringContaining("SELF"),
      fix: "pithy provision --env staging --yes",
    });
    // What it names and what it should name, both on the wire — a client showing the sentence alone is
    // not the only reader, and the pair is the whole finding.
    expect(payload.selfBinding.missing[1]).toEqual({
      worker: "board",
      env: "prod",
      boundTo: "replay-board-prod",
      deploysAs: "replay-prod-board",
      detail: expect.stringContaining("replay-prod-board"),
      // Production's provision stops at a person's phrase, so the finding names none (#697).
      fix: null,
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
