// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { inputOf } from "@pithy-sh/core/src/controlPlane/discovery/routeInput";
import { validate } from "@pithy-sh/core/src/http/validation";
import { describe, expect, test } from "vitest";
import { JobsQuery, SuppressionsQuery } from "./schemas";

/** The property names a route's query hands the manifest, which is what a client discovers a filter by. */
function manifestFields(schema: Parameters<typeof validate>[1]): string[] {
  const input = inputOf([validate("query", schema)]).properties as { query: { properties: object } };
  return Object.keys(input.query.properties);
}

describe("JobsQuery", () => {
  test("takes a template id and a category, and refuses a category the kit does not define", () => {
    expect(JobsQuery.parse({ template: "newsletter", category: "marketing" })).toEqual({
      template: "newsletter",
      category: "marketing",
    });
    expect(JobsQuery.safeParse({ category: "promotional" }).success).toBe(false);
    expect(JobsQuery.safeParse({ template: "" }).success).toBe(false);
    expect(JobsQuery.safeParse({ template: "x".repeat(129) }).success).toBe(false);
  });

  test("both reach the manifest's route input", () => {
    expect(manifestFields(JobsQuery)).toEqual(expect.arrayContaining(["template", "category"]));
  });
});

describe("SuppressionsQuery.active", () => {
  test("decodes to a boolean, and refuses anything but true or false", () => {
    expect(SuppressionsQuery.parse({ active: "false" }).active).toBe(false);
    expect(SuppressionsQuery.safeParse({ active: "yes" }).success).toBe(false);
  });

  test("reaches the manifest's route input", () => {
    expect(manifestFields(SuppressionsQuery)).toContain("active");
  });
});
