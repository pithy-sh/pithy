// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { VectorMetric } from "../config/config";
import { VectorIndexesResponse, VectorIndexMetric } from "./responses";

describe("the index read's response (#730)", () => {
  test("restates config's metric list exactly, so a declared metric always parses", () => {
    expect(VectorIndexMetric.options).toEqual(VectorMetric.options);
  });

  test("carries no field that could hold a namespace name", () => {
    const index = VectorIndexesResponse.shape.indexes.element;
    expect(Object.keys(index.shape)).toEqual(["name", "declared", "vectorize", "documents", "namespaces", "provision"]);
    // A count, never a list: the one field about namespaces is a number.
    expect(index.shape.namespaces.safeParse(["org-1"]).success).toBe(false);
    expect(index.shape.namespaces.safeParse(2).success).toBe(true);
  });
});
