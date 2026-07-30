// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";

describe("defineCapability", () => {
  test("normalizes bindings — optional defaults to false", () => {
    const cap = defineCapability({
      name: "turnstile",
      requiredBindings: [{ type: "secret", name: "TURNSTILE_SECRET" }],
      middleware: [],
    });
    expect(cap.name).toBe("turnstile");
    expect(cap.requiredBindings[0]?.name).toBe("TURNSTILE_SECRET");
    expect(cap.requiredBindings[0]?.optional).toBe(false);
  });

  test("validates bindings at define time", () => {
    expect(() => defineCapability({ name: "bad", requiredBindings: [{ type: "secret", name: "" }] })).toThrow();
  });

  test("supports a config-only capability", () => {
    const cap = defineCapability({
      name: "example",
      config: z.object({ enabled: z.boolean() }),
      requiredBindings: [],
    });
    expect(cap.config?.parse({ enabled: true })).toEqual({ enabled: true });
  });
});
