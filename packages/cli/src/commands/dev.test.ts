// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import dev from "./dev";

/** The args are a static object literal on this command — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown };
const args = dev.args as Record<string, ArgSpec>;

describe("dev command", () => {
  test("is an agent-drivable command with a --json surface", () => {
    expect(dev.meta).toMatchObject({ name: "dev" });
    expect(Object.keys(args)).toEqual(["json"]);
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });
});
