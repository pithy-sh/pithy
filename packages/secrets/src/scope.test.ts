// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ManagedEnvironment, managedEnvironments, resolveWriteTargets } from "./scope";

describe("managed environments", () => {
  test("are the deployed envs — staging and production, never dev", () => {
    expect(ManagedEnvironment.options).toEqual(["staging", "production"]);
    expect(managedEnvironments()).toEqual(["staging", "production"]);
  });
});

describe("resolveWriteTargets (backend × scope routing)", () => {
  test("an environment-scoped secret targets exactly the requested env", () => {
    expect(resolveWriteTargets("d1", "environment", "staging")).toEqual(["staging"]);
    expect(resolveWriteTargets("cf-secrets-store", "environment", "production")).toEqual(["production"]);
  });

  test("a global d1 secret fans out to every managed env", () => {
    expect(resolveWriteTargets("d1", "global", "staging")).toEqual(["staging", "production"]);
    // The requested env does not matter for a global write — it always reaches all.
    expect(resolveWriteTargets("d1", "global", "production")).toEqual(["staging", "production"]);
  });

  test("a global cf-secrets-store secret is written once, canonically via production", () => {
    expect(resolveWriteTargets("cf-secrets-store", "global", "staging")).toEqual(["production"]);
    expect(resolveWriteTargets("cf-secrets-store", "global", "production")).toEqual(["production"]);
  });
});
