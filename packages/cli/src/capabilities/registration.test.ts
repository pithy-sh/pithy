// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { isRegistered } from "./registration";

describe("isRegistered", () => {
  const source = [
    'import { auth } from "@pithy-sh/auth/src/index";',
    "const config = {",
    "  capabilities: [",
    "    auth({",
    '      basePath: "/auth",',
    "    }),",
    "    audit(),",
    "    // pithy:capabilities",
    "  ],",
    "};",
  ].join("\n");

  test("finds a block registration and a one-liner", () => {
    expect(isRegistered(source, "auth")).toBe(true);
    expect(isRegistered(source, "audit")).toBe(true);
  });

  test("an import without a registration is not composed", () => {
    // The import is what `pithy add` writes first. A config that imports a capability and never
    // registers it composes nothing, and boot agrees.
    expect(isRegistered('import { email } from "@pithy-sh/email/src/index";', "email")).toBe(false);
  });

  test("a longer name that merely starts the same is not a match", () => {
    expect(isRegistered(source, "auth2")).toBe(false);
    expect(isRegistered("    myauth(),", "auth")).toBe(false);
  });
});
