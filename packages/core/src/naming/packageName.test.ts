// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { packageOf } from "./packageName";

describe("packageOf", () => {
  test("a scoped specifier keeps its scope: the package is two segments", () => {
    expect(packageOf("@pithy-sh/payments/src/workflows/worker")).toBe("@pithy-sh/payments");
    expect(packageOf("@pithy-sh/payments")).toBe("@pithy-sh/payments");
    expect(packageOf("@sc/pk/src/nope")).toBe("@sc/pk");
  });

  // Every copy this replaced but one took the first two segments whatever they were. That is right for the
  // kit's own `@pithy-sh/*` names and wrong for every unscoped dependency, which is what a cause names.
  test("an unscoped specifier is one segment, never two", () => {
    expect(packageOf("stripe")).toBe("stripe");
    expect(packageOf("fakepkg/src/nope")).toBe("fakepkg");
    expect(packageOf("hono/jsx/jsx-runtime")).toBe("hono");
  });

  test("a scope with nothing after it is answered as written", () => {
    expect(packageOf("@pithy-sh")).toBe("@pithy-sh");
    expect(packageOf("")).toBe("");
  });
});
