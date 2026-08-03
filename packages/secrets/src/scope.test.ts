// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ENVIRONMENTS, isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import { ManagedEnvironment, managedEnvironments, resolveWriteTargets } from "./scope";

describe("managed environments", () => {
  test("are the deployed envs — staging and prod, never dev", () => {
    expect(ManagedEnvironment.options).toEqual(["staging", "prod"]);
    expect(managedEnvironments()).toEqual(["staging", "prod"]);
  });

  test("are exactly core's environments minus local dev", () => {
    // Two lists, one meaning: core's set is what every resource name is budgeted against, and this one
    // is the deployed subset of it. Pinned rather than derived, so adding an environment to core fails
    // here and gets a deliberate answer about whether it has a manager, rather than silently acquiring one.
    expect(managedEnvironments()).toEqual(ENVIRONMENTS.filter((environment) => environment !== "dev"));
  });

  test("are each a name core's naming facade will scope a resource under", () => {
    // A managed environment that core refused would provision nothing: every name the manager deploys
    // under goes through `resourceNames(project).env(environment)`.
    for (const environment of managedEnvironments()) expect(isValidEnvironment(environment)).toBe(true);
  });
});

describe("resolveWriteTargets (backend × scope routing)", () => {
  test("an environment-scoped secret targets exactly the requested env", () => {
    expect(resolveWriteTargets("d1", "environment", "staging")).toEqual(["staging"]);
    expect(resolveWriteTargets("cf-secrets-store", "environment", "prod")).toEqual(["prod"]);
  });

  test("a global d1 secret fans out to every managed env", () => {
    expect(resolveWriteTargets("d1", "global", "staging")).toEqual(["staging", "prod"]);
    // The requested env does not matter for a global write — it always reaches all.
    expect(resolveWriteTargets("d1", "global", "prod")).toEqual(["staging", "prod"]);
  });

  test("a global cf-secrets-store secret is written once, canonically via prod", () => {
    expect(resolveWriteTargets("cf-secrets-store", "global", "staging")).toEqual(["prod"]);
    expect(resolveWriteTargets("cf-secrets-store", "global", "prod")).toEqual(["prod"]);
  });
});
