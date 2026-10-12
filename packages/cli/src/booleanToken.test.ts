// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseArgs } from "citty";
import { describe, expect, test } from "vitest";
import { readBooleanToken } from "./booleanToken";

/**
 * **The bin reads a boolean flag the way citty parses it, or the two render different runs (#697 review).**
 *
 * The rule is measured against citty's own `parseArgs` over every sequence of up to four tokens drawn from each
 * spelling it reads, so a citty upgrade that changes the rule fails here first. The one spelling read where citty
 * does not, `--no-<name>=true|false`, is pinned by its own table, as is what gets reported.
 */

/** Every spelling citty reads for a boolean named `flag`, and the tokens around one that are not it. */
const SPELLINGS = ["--flag", "--flag=true", "--flag=false", "--flag=maybe", "--flag=", "--no-flag", "--other", "pos"];
/** The passthrough separator, placed anywhere in a sequence. */
const POOL = [...SPELLINGS, "--"];

/** Every sequence of up to `length` tokens from `pool`. */
function sequences(pool: readonly string[], length: number): string[][] {
  const out: string[][] = [[]];
  let frontier: string[][] = [[]];
  for (let size = 1; size <= length; size++) {
    frontier = frontier.flatMap((seq) => pool.map((token) => [...seq, token]));
    out.push(...frontier);
  }
  return out;
}

/** What citty makes of `argv` for a declared boolean `flag` with no default. */
function cittyReads(argv: string[]): boolean | undefined {
  const parsed = parseArgs(argv, { flag: { type: "boolean" }, other: { type: "boolean" } }) as { flag?: boolean };
  return parsed.flag;
}

describe("readBooleanToken", () => {
  const all = sequences(POOL, 4);

  test("agrees with citty on every sequence of the spellings citty reads", () => {
    const disagreements = all
      .map((argv) => ({ argv, ours: readBooleanToken(argv, "flag").value, citty: cittyReads(argv) }))
      .filter((row) => row.ours !== row.citty);
    expect(disagreements).toEqual([]);
    expect(all.length).toBeGreaterThan(7000);
  });

  test.each([
    { argv: [], value: undefined },
    { argv: ["--flag"], value: true },
    { argv: ["--flag=true"], value: true },
    { argv: ["--flag=false"], value: false },
    { argv: ["--no-flag"], value: false },
    { argv: ["--flag", "--flag=false"], value: false },
    { argv: ["--flag=false", "--flag"], value: true },
    // A bare negation wins wherever it is: citty applies it after everything else.
    { argv: ["--flag", "--no-flag"], value: false },
    { argv: ["--no-flag", "--flag"], value: false },
    // citty reads any value but `false` as on.
    { argv: ["--flag=maybe"], value: true },
    { argv: ["--flag="], value: true },
    // After `--` is a child's argv.
    { argv: ["--flag", "--", "--no-flag"], value: true },
    { argv: ["--", "--flag"], value: undefined },
    // A name that merely starts with this one is another flag.
    { argv: ["--flagged", "--no-flagged"], value: undefined },
  ])("$argv reads $value, as citty does", ({ argv, value }) => {
    expect(readBooleanToken(argv, "flag").value).toBe(value);
    expect(cittyReads(argv)).toBe(value);
  });

  /** citty ignores these entirely. They are read as the double negative they spell, and reported. */
  test.each([
    { argv: ["--no-flag=true"], value: false },
    { argv: ["--no-flag=false"], value: true },
    { argv: ["--flag", "--no-flag=true"], value: false },
    { argv: ["--no-flag=true", "--flag"], value: true },
    { argv: ["--no-flag=false", "--no-flag"], value: false },
  ])("$argv reads $value, and is reported as the spelling citty ignores", ({ argv, value }) => {
    const read = readBooleanToken(argv, "flag");
    expect(read.value).toBe(value);
    expect(read.negatedValue).toBe(argv.find((token) => token.startsWith("--no-flag=")));
  });

  test.each([
    { argv: ["--flag=maybe"], malformed: "--flag=maybe" },
    { argv: ["--flag="], malformed: "--flag=" },
    { argv: ["--flag=1", "--flag=x"], malformed: "--flag=1" },
    { argv: ["--no-flag=1"], malformed: "--no-flag=1" },
    { argv: ["--flag=true", "--no-flag=false", "--flag"], malformed: undefined },
    { argv: ["--", "--flag=maybe"], malformed: undefined },
  ])("$argv reports $malformed as malformed", ({ argv, malformed }) => {
    expect(readBooleanToken(argv, "flag").malformed).toBe(malformed);
  });

  test("a malformed negation is not an answer", () => {
    expect(readBooleanToken(["--flag", "--no-flag=1"], "flag").value).toBe(true);
    expect(readBooleanToken(["--no-flag=1"], "flag").value).toBeUndefined();
  });

  test("nothing typed reports nothing", () => {
    expect(readBooleanToken(["deploy", "--env", "prod"], "flag")).toEqual({
      value: undefined,
      malformed: undefined,
      negatedValue: undefined,
    });
  });
});
