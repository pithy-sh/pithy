// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DEFAULT_ENVIRONMENTS, ENVIRONMENTS, isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import { canonicalGlobalEnvironment, ManagedEnvironment, managedEnvironments, resolveWriteTargets } from "./scope";

describe("managed environments", () => {
  test("are exactly what the project declared — the default set behaves as the old closed enum did", () => {
    expect(managedEnvironments(DEFAULT_ENVIRONMENTS)).toEqual(["staging", "prod"]);
  });

  test("include an environment core never heard of, once the project declares it", () => {
    // The whole point. `live` used to be a legal `--env`, a real `<project>-live-db`, and no master key.
    expect(managedEnvironments(["staging", "live"])).toEqual(["staging", "live"]);
  });

  test("never include dev — the declaration cannot name it, and nothing else can add it", () => {
    expect(managedEnvironments(DEFAULT_ENVIRONMENTS)).not.toContain("dev");
    expect(ENVIRONMENTS.filter((environment) => environment !== "dev")).toEqual([...DEFAULT_ENVIRONMENTS]);
  });

  test("are each a name core's naming facade will scope a resource under", () => {
    // A managed environment that core refused would provision nothing: every name the manager deploys
    // under goes through `resourceNames(project).env(environment)`.
    for (const environment of managedEnvironments(["staging", "live"])) {
      expect(isValidEnvironment(environment)).toBe(true);
    }
  });
});

describe("ManagedEnvironment", () => {
  test("takes any name a deployed environment may carry, not a closed pair", () => {
    expect(ManagedEnvironment.parse("staging")).toBe("staging");
    expect(ManagedEnvironment.parse("live")).toBe("live");
  });

  test("still refuses dev, global, and anything the naming rule refuses", () => {
    for (const bad of ["dev", "global", "production", "Prod", ""]) {
      expect(ManagedEnvironment.safeParse(bad).success).toBe(false);
    }
  });
});

describe("canonicalGlobalEnvironment", () => {
  test("is the last declared environment — `prod` for the default set, as it always was", () => {
    expect(canonicalGlobalEnvironment(DEFAULT_ENVIRONMENTS)).toBe("prod");
  });

  test("is a declared environment even when the project has no `prod`", () => {
    // Hardcoding `prod` wrote an account-level secret through a manager that was never deployed.
    expect(canonicalGlobalEnvironment(["staging", "live"])).toBe("live");
  });
});

describe("resolveWriteTargets (backend × scope routing)", () => {
  test("an environment-scoped secret targets exactly the requested env", () => {
    expect(resolveWriteTargets("d1", "environment", "staging", DEFAULT_ENVIRONMENTS)).toEqual(["staging"]);
    expect(resolveWriteTargets("cf-secrets-store", "environment", "prod", DEFAULT_ENVIRONMENTS)).toEqual(["prod"]);
  });

  test("a global d1 secret fans out to every declared env", () => {
    expect(resolveWriteTargets("d1", "global", "staging", DEFAULT_ENVIRONMENTS)).toEqual(["staging", "prod"]);
    // The requested env does not matter for a global write — it always reaches all.
    expect(resolveWriteTargets("d1", "global", "prod", DEFAULT_ENVIRONMENTS)).toEqual(["staging", "prod"]);
    expect(resolveWriteTargets("d1", "global", "live", ["staging", "live"])).toEqual(["staging", "live"]);
  });

  test("a global cf-secrets-store secret is written once, through the canonical env", () => {
    expect(resolveWriteTargets("cf-secrets-store", "global", "staging", DEFAULT_ENVIRONMENTS)).toEqual(["prod"]);
    expect(resolveWriteTargets("cf-secrets-store", "global", "prod", DEFAULT_ENVIRONMENTS)).toEqual(["prod"]);
    expect(resolveWriteTargets("cf-secrets-store", "global", "staging", ["staging", "live"])).toEqual(["live"]);
  });
});
