// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { Capability } from "../capability/capability";
import { composedUsageMeter, isUsageMeterProvider, type UsageMeter } from "./meter";

const meter: UsageMeter = { provider: "payments", charge: async () => {} };
const provider = { name: "payments", usageMeter: meter } as unknown as Capability;
const other = { name: "email" } as unknown as Capability;

describe("the usage-meter seam", () => {
  test("a capability carrying a meter with a charge is a provider; anything else is not", () => {
    expect(isUsageMeterProvider(provider)).toBe(true);
    expect(isUsageMeterProvider(other)).toBe(false);
    expect(isUsageMeterProvider({ name: "x", usageMeter: {} } as unknown as Capability)).toBe(false);
  });

  test("the composed meter is found among the capabilities, or is absent", () => {
    expect(composedUsageMeter([other, provider])).toBe(meter);
    expect(composedUsageMeter([other])).toBeUndefined();
  });
});
