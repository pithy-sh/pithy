// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CATALOG } from "@pithy-sh/cli/src/capabilities/catalog";
import { describe, expect, test } from "vitest";
import { REFERENCE_COMPOSITION } from "./composition";

describe("the reference Worker's composition", () => {
  test("composes every capability the kit catalogs, and nothing it does not", () => {
    expect(Object.keys(REFERENCE_COMPOSITION).sort()).toEqual(CATALOG.map((entry) => entry.name).sort());
  });

  test("composes each one without a refusal", () => {
    for (const [name, compose] of Object.entries(REFERENCE_COMPOSITION)) {
      expect(compose().name, name).toBe(name);
    }
  });
});
