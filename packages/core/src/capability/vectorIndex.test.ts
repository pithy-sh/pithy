// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";
import { assertVectorIndexContributions } from "./vectorIndex";

const reprocess = { binding: "X_REPROCESS", className: "XReprocess", params: z.object({}), optional: true } as const;

describe("vector index contributions", () => {
  test("a declaration naming a registered job composes, and is carried on the capability", () => {
    const capability = defineCapability({
      name: "x",
      requiredBindings: [],
      workflows: { reprocess },
      vectorIndexes: [{ name: "x-things", reprocessJob: "reprocess" }],
    });
    expect(capability.vectorIndexes).toEqual([{ name: "x-things", reprocessJob: "reprocess" }]);
  });

  test("a job the capability does not register is refused where it is written", () => {
    expect(() =>
      defineCapability({
        name: "x",
        requiredBindings: [],
        vectorIndexes: [{ name: "x-things", reprocessJob: "reprocess" }],
      }),
    ).toThrow(/does not register/);
  });

  test("the same index twice is refused", () => {
    expect(() =>
      assertVectorIndexContributions(
        "x",
        [
          { name: "a", reprocessJob: "reprocess" },
          { name: "a", reprocessJob: "reprocess" },
        ],
        ["reprocess"],
      ),
    ).toThrow(/twice/);
  });
});
