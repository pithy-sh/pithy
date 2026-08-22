// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { canonicalText, KNOWN_LICENSES } from "./licenses";

describe("canonicalText", () => {
  test("returns the MIT text", () => {
    const text = canonicalText("MIT");
    expect(text).toContain("MIT License");
    expect(text).toContain("Permission is hereby granted, free of charge");
  });

  test("returns the FSL text", () => {
    expect(canonicalText("FSL-1.1-MIT")).toContain("Functional Source License");
  });

  test("returns null for a license it holds no text for", () => {
    expect(canonicalText("Apache-2.0")).toBeNull();
  });

  // The id comes from a package.json `license` field, so it is a string from a file. Resolving it
  // into a path unchecked lets `../` walk out of `licenses/`; the allowlist is what stops it being
  // a path at all.
  test("refuses an id that traverses out of the licenses directory", () => {
    expect(canonicalText("../licenses/MIT")).toBeNull();
  });

  test("ends with exactly one trailing newline, so a generated LICENSE is POSIX-clean", () => {
    for (const id of KNOWN_LICENSES) {
      expect(canonicalText(id)?.endsWith("\n")).toBe(true);
      expect(canonicalText(id)?.endsWith("\n\n")).toBe(false);
    }
  });
});

describe("KNOWN_LICENSES", () => {
  test("covers every license this repo declares", () => {
    expect([...KNOWN_LICENSES].sort()).toEqual(["FSL-1.1-MIT", "MIT"]);
  });
});
