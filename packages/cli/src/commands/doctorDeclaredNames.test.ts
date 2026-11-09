// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DeclaredNamesCheck } from "../doctor/declaredNames";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

const harness = doctorHarness();
const { healthyOptions } = harness;

/** What `pithy doctor` says about a stanza naming a resource other than the one provision would name. */
async function reportWith(declaredNames: DeclaredNamesCheck) {
  return buildDoctorReport(healthyOptions({ checkDeclaredNames: async () => declaredNames }));
}

/** The reporter's hand edit: `other`'s staging names its own database, and `other` owns nothing. */
const DRIFTED: DeclaredNamesCheck = {
  state: "drifted",
  mismatches: [
    {
      worker: "other",
      env: "staging",
      binding: "DB",
      kind: "d1",
      declared: "my-app-staging-other-db",
      expected: "my-app-staging-db",
      owned: false,
      global: false,
    },
  ],
  unrecognized: [{ worker: "other", binding: "DBB" }],
};

describe("a stanza naming another resource than provision would", () => {
  test("prints the block, both remedies, and the stale ownBindings entry", async () => {
    const text = renderDoctorText(await reportWith(DRIFTED), "/home/u");
    expect(text).toContain("Resource names:");
    expect(text).toContain("staging names DB my-app-staging-other-db. Provisioning names it my-app-staging-db.");
    expect(text).toContain("add DB to ownBindings in apps/other/pithy.worker.jsonc");
    expect(text).toContain("pithy provision --env staging --yes --repoint");
    expect(text).toContain("ownBindings lists DBB");
  });

  test("never fails the run", async () => {
    expect(doctorExitCode(await reportWith(DRIFTED))).toBe(0);
  });

  test("carries the finding into --json, sentence and all", async () => {
    const payload = renderDoctorJson(await reportWith(DRIFTED)) as {
      declaredNames: { state: string; mismatches: { declared: string; detail: string; fix: null }[] };
    };
    expect(payload.declaredNames.state).toBe("drifted");
    expect(payload.declaredNames.mismatches[0]?.declared).toBe("my-app-staging-other-db");
    expect(payload.declaredNames.mismatches[0]?.fix).toBeNull();
  });

  test("says nothing when every name agrees", async () => {
    const text = renderDoctorText(await reportWith({ state: "ok", mismatches: [], unrecognized: [] }), "/home/u");
    expect(text).not.toContain("Resource names:");
  });
});
