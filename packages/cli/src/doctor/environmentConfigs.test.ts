// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { SecretApplicability } from "../capabilities/secretApplicability";
import { checkEnvironmentConfigs, describeEnvironmentConfigs } from "./environmentConfigs";

/**
 * **A config that does not load for a declared environment is a fault, and doctor is where it is met
 * (#548).**
 *
 * `projectSecretApplicability` is the one thing in the CLI that composes every declared environment, so it
 * is the first thing in a run that learns `prod`'s `pithy.config.ts` throws. It used to feed that failure
 * back into its own fold as *every name in reach*, which turned #541 off wherever one environment was
 * half-configured; it contributes nothing now, and this check is where what it found gets reported.
 *
 * The property these hold is that the reporting is a **projection and nothing else**. The check invents no
 * sentence, reorders nothing, and drops nothing — the environments and the reasons that reach an operator
 * are the configs' own, because a second wording of one failure is how two commands come to disagree about
 * one project.
 */
describe("checkEnvironmentConfigs", () => {
  /** What the sweep answers for a project whose `prod` throws and whose other environments compose. */
  function swept(unresolved: SecretApplicability["unresolved"]): SecretApplicability {
    return { project: new Map(), byWorker: new Map(), unresolved };
  }

  test("carries every environment the sweep could not compose, with its reason", () => {
    const check = checkEnvironmentConfigs(
      swept([{ environment: "prod", reason: "Set payments.billing in apps/api/pithy.config.ts." }]),
    );
    expect(check.unresolved).toEqual([
      { environment: "prod", reason: "Set payments.billing in apps/api/pithy.config.ts." },
    ]);
  });

  /** The healthy answer, and the one almost every project gives: nothing found, nothing said. */
  test("is empty when every declared environment composed", () => {
    expect(checkEnvironmentConfigs(swept([])).unresolved).toEqual([]);
  });
});

describe("describeEnvironmentConfigs", () => {
  test("says nothing at all when every environment composed", () => {
    expect(describeEnvironmentConfigs({ unresolved: [] })).toEqual([]);
  });

  /**
   * One line per environment, naming it and the config's own action. The action is what an operator acts
   * on, and it is the loader's rather than this module's — `loadReason` takes `action` over `message` and
   * never reads `detail`, so nothing the throw site meant for a log reaches a terminal here.
   */
  test("names each environment and the action its config gave", () => {
    expect(
      describeEnvironmentConfigs({
        unresolved: [
          { environment: "prod", reason: "Set payments.billing in apps/api/pithy.config.ts." },
          { environment: "staging", reason: "Make the checkout writable." },
        ],
      }),
    ).toEqual(["prod: Set payments.billing in apps/api/pithy.config.ts.", "staging: Make the checkout writable."]);
  });
});
