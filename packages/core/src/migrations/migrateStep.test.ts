// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { migrateStep } from "./migrateStep";

describe("migrateStep", () => {
  test("names the environment the Worker runs in", () => {
    expect(migrateStep({ ENVIRONMENT: "staging" })).toBe("run pithy migrate --env staging");
  });

  // A bare `pithy migrate` acts on dev, which is not the database a deployed Worker is missing.
  test("names no command it cannot complete, where the Worker knows no environment", () => {
    expect(migrateStep({})).toBe("migrate this environment with pithy migrate, naming it with --env");
  });
});
