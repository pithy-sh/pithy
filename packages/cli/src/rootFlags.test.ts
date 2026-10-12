// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  malformedNoInputFlag,
  malformedPrettyFlag,
  ROOT_FLAG_DESCRIPTIONS,
  ROOT_FLAGS,
  wantsNoInput,
  wantsPretty,
  wantsVersion,
} from "./rootFlags";

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

  /**
   * Read by citty's rule, as every boolean flag is (`booleanToken.ts`, #697 review): a bare `--no-pretty` wins
   * wherever it is, so an alias carrying `--pretty` is overridden by `--no-pretty`, and one carrying `--no-pretty`
   * is not undone by `--pretty`. `PITHY_JSON` is the lever for a session-wide setting.
   */
  test("a bare --no-pretty wins wherever it is; otherwise the last --pretty decides", () => {
    expect(wantsPretty(["--pretty", "--no-pretty"])).toBe(false);
    expect(wantsPretty(["--no-pretty", "--pretty"])).toBe(false);
    expect(wantsPretty(["--pretty=false", "--pretty"])).toBe(true);
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
  test("carries both pretty spellings and --no-input beside --help and --version", () => {
    expect([...ROOT_FLAGS].sort()).toEqual([
      "--help",
      "--no-input",
      "--no-pretty",
      "--pretty",
      "--version",
      "-h",
      "-v",
    ]);
  });
});

/** `--no-input` forbids prompts for one call (#697), read off the raw tokens like `--pretty`. */
describe("wantsNoInput", () => {
  test("absent is undefined, so the variable and --json decide", () => {
    expect(wantsNoInput(["init"])).toBeUndefined();
    expect(wantsNoInput([])).toBeUndefined();
  });

  test("the bare flag forbids, on any command and on either side of a positional", () => {
    expect(wantsNoInput(["--no-input", "init"])).toBe(true);
    expect(wantsNoInput(["add", "auth", "--no-input"])).toBe(true);
  });

  /** Read by the one rule every boolean flag is read by (`booleanToken.ts`): a bare `--no-input` wins wherever it is. */
  test("=true and =false are read, the last of them wins, and a bare --no-input wins over both", () => {
    expect(wantsNoInput(["init", "--no-input=true"])).toBe(true);
    expect(wantsNoInput(["init", "--no-input=false"])).toBe(false);
    expect(wantsNoInput(["init", "--no-input=true", "--no-input=false"])).toBe(false);
    expect(wantsNoInput(["init", "--no-input", "--no-input=false"])).toBe(true);
  });

  test("a malformed value is no answer here; malformedNoInputFlag reports it", () => {
    expect(wantsNoInput(["init", "--no-input=maybe"])).toBeUndefined();
  });

  test("anything after -- is a child's, and look-alikes are not it", () => {
    expect(wantsNoInput(["dev", "--", "--no-input"])).toBeUndefined();
    expect(wantsNoInput(["init", "--no-inputs", "--input"])).toBeUndefined();
  });
});

describe("malformedNoInputFlag", () => {
  test("names the first token whose value is neither true nor false", () => {
    expect(malformedNoInputFlag(["init", "--no-input=1", "--no-input=x"])).toBe("--no-input=1");
  });

  test("well-formed spellings and payload after -- are not malformed", () => {
    expect(malformedNoInputFlag(["init", "--no-input", "--no-input=false"])).toBeUndefined();
    expect(malformedNoInputFlag(["dev", "--", "--no-input=x"])).toBeUndefined();
  });
});

/** What `pithy schema` publishes for the root flags is the list `bin.ts` answers, described (#697). */
describe("ROOT_FLAG_DESCRIPTIONS", () => {
  test("names every spelling ROOT_FLAGS holds, exactly once, each with what it does", () => {
    const spellings = ROOT_FLAG_DESCRIPTIONS.flatMap((flag) => [flag.name, ...flag.aliases]);
    expect(spellings.sort()).toEqual([...ROOT_FLAGS].sort());
    for (const flag of ROOT_FLAG_DESCRIPTIONS) expect(flag.description).not.toBe("");
  });
});
