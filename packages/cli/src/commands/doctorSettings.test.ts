// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { SettingsCheck } from "../doctor/settings";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * The `Settings:` block — whether each composed capability's settings **work**, not merely that they are
 * present (#411).
 *
 * Every scenario goes through the injected `checkSettings` seam, so nothing here reaches a capability, a
 * config, or an account: what is under test is doctor's half of the contract — which states print, which
 * states gate the exit, and that a skipped account tier is never rendered as a pass.
 */

const harness = doctorHarness();

const check = (overrides: Partial<SettingsCheck> = {}): SettingsCheck => ({
  state: "ok",
  account: { state: "checked", reason: null },
  checked: [{ worker: "api", capability: "email" }],
  findings: [],
  unchecked: [],
  ...overrides,
});

const report = (settings: SettingsCheck | null) =>
  buildDoctorReport(harness.healthyOptions({ checkSettings: async () => settings }));

describe("a capability that declares no check", () => {
  test("says nothing, reports null, and does not fail the exit", async () => {
    const built = await report(null);
    expect(renderDoctorText(built, harness.dir)).not.toContain("Settings:");
    expect(renderDoctorJson(built).settings).toBeNull();
    expect(doctorExitCode(built)).toBe(0);
  });
});

describe("everything works", () => {
  test("collapses to one line, in the terse report as well", async () => {
    const built = await report(check());
    expect(renderDoctorText(built, harness.dir)).toContain("Settings: every composed capability's settings work ✓");
    expect(doctorExitCode(built)).toBe(0);
  });

  test("a project whose capabilities ask the account nothing still reads as a pass", async () => {
    const built = await report(check({ account: { state: "skipped", reason: "not-declared" } }));
    expect(renderDoctorText(built, harness.dir)).toContain("Settings: every composed capability's settings work ✓");
    expect(doctorExitCode(built)).toBe(0);
  });
});

describe("a local finding", () => {
  const local = check({
    state: "faults",
    findings: [
      {
        worker: "api",
        capability: "email",
        tier: "local",
        setting: "BASE_URL",
        environment: null,
        problem: "Links are built against http://localhost:8787, and nothing declares it.",
        action: "Set `email({ baseUrl })` to an origin this project serves.",
      },
    ],
  });

  test("renders a problem line and an action line beneath it", async () => {
    const text = renderDoctorText(await report(local), harness.dir);
    expect(text).toContain("Settings:");
    expect(text).toContain("  api:");
    expect(text).toContain(
      "    email        BASE_URL — Links are built against http://localhost:8787, and nothing declares it.",
    );
    expect(text).toContain("                 Set `email({ baseUrl })` to an origin this project serves.");
  });

  test("fails the exit", async () => {
    expect(doctorExitCode(await report(local))).toBe(1);
  });
});

describe("the account tier, three outcomes", () => {
  const finding = {
    worker: "api",
    capability: "email",
    tier: "account" as const,
    setting: "fromAddress",
    environment: null,
    problem: "acme.dev is not a zone on this Cloudflare account.",
    action: "Add acme.dev to this Cloudflare account.",
  };

  test("reached and passing: nothing to say, exit 0", async () => {
    expect(doctorExitCode(await report(check()))).toBe(0);
  });

  test("reached and failing: the same standard as a local finding, exit 1", async () => {
    const built = await report(check({ state: "faults", findings: [finding] }));
    expect(renderDoctorText(built, harness.dir)).toContain("email        fromAddress — acme.dev is not a zone");
    expect(doctorExitCode(built)).toBe(1);
  });

  test("unreachable: reported as skipped, never as passed, and it does not fail the exit", async () => {
    const built = await report(check({ account: { state: "skipped", reason: "offline" } }));
    const text = renderDoctorText(built, harness.dir);
    expect(text).toContain("account checks skipped (offline) — nothing here was established about the account");
    expect(text).not.toContain("every composed capability's settings work");
    expect(doctorExitCode(built)).toBe(0);
  });
});

describe("a check that could not run", () => {
  const unchecked = check({
    state: "could-not-check",
    checked: [],
    unchecked: [{ worker: "api", capability: "email", tier: "local" }],
  });

  test("says so rather than passing, and never fails the exit", async () => {
    const built = await report(unchecked);
    expect(renderDoctorText(built, harness.dir)).toContain("email        local checks couldn't be run");
    expect(doctorExitCode(built)).toBe(0);
  });
});

describe("the probe itself could not run", () => {
  /**
   * The whole-probe failure — the root config has no `name`, a Worker's `pithy.config.ts` will not
   * import, the seam threw. Nothing was established about anything, and the one reading it must not be
   * the account: attributing a local failure to Cloudflare sends the reader to the wrong machine.
   */
  test("says the checks could not be run, blames no account, and keeps the report verbose", async () => {
    const built = await buildDoctorReport(
      harness.healthyOptions({
        checkSettings: async () => {
          throw new Error("no project name in pithy.config.ts");
        },
      }),
    );
    const text = renderDoctorText(built, harness.dir);
    expect(text).toContain("Settings:");
    expect(text).toContain("the checks could not be run, so nothing here was established");
    expect(text).not.toContain("about the account");
    // A check that never ran is not a pass, so the report stays long enough to be read.
    expect(text).not.toContain("Everything checks out");
    expect(doctorExitCode(built)).toBe(0);
  });

  test("a project whose Workers would not resolve reports could-not-check, never null", async () => {
    // `null` is the documented shape for "no composed capability declares a check". An agent reading
    // it after a config that would not import would conclude this project has no settings questions.
    const built = await buildDoctorReport(
      harness.healthyOptions({
        resolveWorkers: async () => {
          throw new ConflictError({ message: "apps/api/pithy.config.ts would not import." });
        },
      }),
    );
    expect(renderDoctorJson(built).settings).toMatchObject({ state: "could-not-check", findings: [], unchecked: [] });
  });
});

describe("--json", () => {
  test("carries every finding with its own sentence, every skip, and the tier's state", async () => {
    const built = await report(
      check({
        state: "faults",
        account: { state: "skipped", reason: "no-credentials" },
        unchecked: [{ worker: "collab", capability: "email", tier: "account" }],
        findings: [
          {
            worker: "api",
            capability: "email",
            tier: "local",
            setting: "BASE_URL",
            environment: "prod",
            problem: "Not a URL.",
            action: "Run pithy email provision --env prod.",
          },
        ],
      }),
    );
    expect(renderDoctorJson(built).settings).toEqual({
      state: "faults",
      account: { state: "skipped", reason: "no-credentials" },
      checked: [{ worker: "api", capability: "email" }],
      findings: [
        {
          worker: "api",
          capability: "email",
          tier: "local",
          setting: "BASE_URL",
          environment: "prod",
          problem: "Not a URL.",
          action: "Run pithy email provision --env prod.",
          detail: "email: BASE_URL (prod) — Not a URL. Run pithy email provision --env prod.",
        },
      ],
      unchecked: [{ worker: "collab", capability: "email", tier: "account" }],
      detail: "account checks skipped (no Cloudflare credentials) — nothing here was established about the account",
    });
  });
});
