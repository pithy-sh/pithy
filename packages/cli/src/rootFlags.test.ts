// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { wantsVersion } from "./rootFlags";

describe("wantsVersion", () => {
  test("answers the bare root flags", () => {
    expect(wantsVersion(["--version"])).toBe(true);
    expect(wantsVersion(["-v"])).toBe(true);
  });

  test("answers on any command, not just the root — the §1.2 claim", () => {
    expect(wantsVersion(["add", "--version"])).toBe(true);
    expect(wantsVersion(["add", "-v"])).toBe(true);
    expect(wantsVersion(["token", "create", "--version"])).toBe(true);
    expect(wantsVersion(["migrate", "--json", "--version"])).toBe(true);
  });

  test("stays out of the way when nothing asks for it", () => {
    expect(wantsVersion([])).toBe(false);
    expect(wantsVersion(["add", "auth"])).toBe(false);
    expect(wantsVersion(["migrate", "--json"])).toBe(false);
  });

  test("does not fire on a token that merely contains the word", () => {
    // `--set version=2` is a value, not the flag; so is a capability literally named `version`.
    expect(wantsVersion(["add", "auth", "--set", "version=2"])).toBe(false);
    expect(wantsVersion(["add", "--set=version=2"])).toBe(false);
    expect(wantsVersion(["add", "version"])).toBe(false);
    expect(wantsVersion(["--versions"])).toBe(false);
    expect(wantsVersion(["--no-version"])).toBe(false);
  });

  test("stops at `--`, so passthrough payload is never read as a Pithy flag", () => {
    expect(wantsVersion(["dev", "--", "--version"])).toBe(false);
    expect(wantsVersion(["dev", "--", "-v"])).toBe(false);
    expect(wantsVersion(["dev", "--version", "--", "-v"])).toBe(true);
  });

  test("`--flag=--version` is the escape for a literal value", () => {
    expect(wantsVersion(["token", "create", "--permission=--version"])).toBe(false);
  });

  test("help wins, the way citty resolves it first", () => {
    expect(wantsVersion(["--help", "--version"])).toBe(false);
    expect(wantsVersion(["add", "--version", "--help"])).toBe(false);
    expect(wantsVersion(["add", "-v", "-h"])).toBe(false);
  });
});
