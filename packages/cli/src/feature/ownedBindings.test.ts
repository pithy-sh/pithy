// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { ownedBindingsOf } from "./ownedBindings";

const app = defineCapability({
  name: "app",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "SESSIONS" },
    { type: "ratelimit", name: "LIMIT" },
  ] satisfies BindingSpecInput[],
});

describe("ownedBindingsOf", () => {
  test("lists each provisionable binding a Worker owns, under its directory", () => {
    expect(
      ownedBindingsOf([
        { dir: "/p/apps/api", capabilities: [app] },
        { dir: "/p/apps/business", ownBindings: ["DB", "SESSIONS"], capabilities: [app] },
      ]),
    ).toEqual([
      { app: "business", binding: "DB", kind: "d1" },
      { app: "business", binding: "SESSIONS", kind: "kv" },
    ]);
  });

  test("owns nothing for an entry naming no provisionable binding the Worker composes", () => {
    expect(ownedBindingsOf([{ dir: "/p/apps/x", ownBindings: ["LIMIT", "NOPE"], capabilities: [app] }])).toEqual([]);
  });
});
