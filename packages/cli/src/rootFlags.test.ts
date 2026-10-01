// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { malformedPrettyFlag, ROOT_FLAGS, wantsPretty, wantsVersion } from "./rootFlags";

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

/**
 * `--pretty` / `--no-pretty` are read off raw argv here, the same way `wantsVersion` is and for the same
 * reason: `bin.ts` answers them before citty parses, so no command declares one and no parse has happened
 * yet. They are a root flag rather than fifty copies of a convention — see `declaredFlags.ts` for the
 * pairing rule that makes `--pretty` mean `--json --pretty` and nothing else.
 */
describe("wantsPretty", () => {
  test("undefined when neither is typed — the ambient default decides", () => {
    expect(wantsPretty([])).toBeUndefined();
    expect(wantsPretty(["doctor", "--json"])).toBeUndefined();
  });

  test("answers the bare flags", () => {
    expect(wantsPretty(["doctor", "--json", "--pretty"])).toBe(true);
    expect(wantsPretty(["doctor", "--json", "--no-pretty"])).toBe(false);
  });

  test("answers on any command, wherever it is typed", () => {
    expect(wantsPretty(["--pretty", "token", "mint", "--json"])).toBe(true);
    expect(wantsPretty(["secrets", "rotate", "API_KEY", "--json", "--no-pretty"])).toBe(false);
  });

  /** Last wins, which is what every parser does with a repeated flag and what a shell alias relies on. */
  test("the last one typed wins, so an alias can be overridden on the command line", () => {
    expect(wantsPretty(["--pretty", "--no-pretty"])).toBe(false);
    expect(wantsPretty(["--no-pretty", "--pretty"])).toBe(true);
    expect(wantsPretty(["--pretty", "--no-pretty", "--pretty"])).toBe(true);
  });

  test("stops at `--`, so passthrough payload is never read as a Pithy flag", () => {
    expect(wantsPretty(["dev", "--", "--pretty"])).toBeUndefined();
    expect(wantsPretty(["dev", "--pretty", "--", "--no-pretty"])).toBe(true);
  });

  test("does not fire on a token that merely contains the word", () => {
    expect(wantsPretty(["--prettier"])).toBeUndefined();
    expect(wantsPretty(["add", "pretty"])).toBeUndefined();
    expect(wantsPretty(["--set=pretty=1"])).toBeUndefined();
  });

  /**
   * **`--pretty=false` has to mean compact, because the parser already lets it through.**
   *
   * `scan()` records Node `parseArgs`' `rawName`, which is `--pretty` for `--pretty=true` — so the
   * undeclared-flag check accepts the token. Reading only the bare spelling left `--pretty=false` at a
   * terminal accepted, ignored, and *indented*: the operator asked for compact and got the opposite,
   * which is precisely the ambient surprise this feature exists to close. `asksForJson` already reads
   * `--json=false`, so an operator mirroring that spelling onto `--pretty` is the expected path.
   */
  test("reads the `=value` spelling, because the parser accepts it", () => {
    expect(wantsPretty(["doctor", "--json", "--pretty=true"])).toBe(true);
    expect(wantsPretty(["doctor", "--json", "--pretty=false"])).toBe(false);
    expect(wantsPretty(["doctor", "--json", "--no-pretty=true"])).toBe(false);
    expect(wantsPretty(["doctor", "--json", "--no-pretty=false"])).toBe(true);
  });

  test("last wins across spellings", () => {
    expect(wantsPretty(["--pretty", "--pretty=false"])).toBe(false);
    expect(wantsPretty(["--pretty=false", "--pretty"])).toBe(true);
  });
});

/**
 * A value that is neither `true` nor `false` is refused rather than ignored — the same rule
 * `PITHY_JSON` is held to, and for the same reason: a typo that reverts to the default is
 * indistinguishable from the flag working.
 */
describe("malformedPrettyFlag", () => {
  test("is undefined for every well-formed spelling", () => {
    for (const argv of [[], ["--pretty"], ["--no-pretty"], ["--pretty=true"], ["--no-pretty=false"], ["--prettier"]]) {
      expect({ argv, found: malformedPrettyFlag(argv) }).toEqual({ argv, found: undefined });
    }
  });

  test("names the token when the value is neither true nor false", () => {
    expect(malformedPrettyFlag(["doctor", "--json", "--pretty=maybe"])).toBe("--pretty=maybe");
    expect(malformedPrettyFlag(["doctor", "--json", "--pretty="])).toBe("--pretty=");
    expect(malformedPrettyFlag(["doctor", "--no-pretty=1"])).toBe("--no-pretty=1");
  });

  test("stops at `--`, like every other reader here", () => {
    expect(malformedPrettyFlag(["dev", "--", "--pretty=maybe"])).toBeUndefined();
  });
});

/**
 * Declared once, here, and read by `declaredFlags.ts` and the docs catalog from this list rather than
 * restated in either. Two flags went missing from the catalog exactly once, by being written out twice.
 */
describe("ROOT_FLAGS", () => {
  test("carries both pretty spellings beside --help and --version", () => {
    expect([...ROOT_FLAGS].sort()).toEqual(["--help", "--no-pretty", "--pretty", "--version", "-h", "-v"]);
  });
});
