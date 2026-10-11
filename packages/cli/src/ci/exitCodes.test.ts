// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, resolve, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { EXIT } from "../terminal/exitClass";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **An exit code is chosen by kind, in one table, and nowhere else (#697).**
 *
 * `terminal/exitClass.ts` maps every kit error code to a class and every class to a number, and
 * `withErrorReporting` exits through it. That is only the contract if nothing beside it picks a number of
 * its own: a `process.exit(1)` written at a prompt's cancel is how an interrupt came to read as an
 * unclassified failure, and `secrets` once carried three private codes that meant something else.
 *
 * So no shipped module exits with a non-zero literal — it names `EXIT.<class>`, or throws and lets the
 * funnel decide. The exceptions are listed with their reasons, and a listed site that stops matching
 * fails here too, so the list cannot outlive what it excuses.
 */

/** The CLI's source root. */
const SRC = resolve(import.meta.dirname, "..");

/** A non-zero literal handed to `process.exit(` or assigned to `process.exitCode`. */
const LITERAL_EXIT = /process\.exit\(\s*([1-9]\d*)\s*\)|process\.exitCode\s*=\s*([1-9]\d*)\b/g;

/** The sites allowed a literal, by `src`-relative path, and the number each must be. */
const ALLOWED: Record<string, { code: number; why: string }> = {
  "bin.ts": {
    code: EXIT.precondition,
    why: "The Node floor check runs before anything is imported, so it cannot read the table.",
  },
  "docs/writeCatalog.ts": { code: EXIT.failed, why: "A build script, run by CI, never by an adopter." },
};

/** Every literal exit in shipped source, as `path: code`. */
function literalExits(): { path: string; code: number }[] {
  const found: { path: string; code: number }[] = [];
  for (const path of sourcePaths(SRC)) {
    const code = blankComments(readSource(path) ?? "");
    for (const match of code.matchAll(LITERAL_EXIT)) {
      found.push({ path: relative(SRC, path).split(sep).join("/"), code: Number(match[1] ?? match[2]) });
    }
  }
  return found;
}

describe("exit codes are named, not written", () => {
  const exits = literalExits();

  test("no shipped module exits with a number of its own", () => {
    expect(exits.filter((exit) => !(exit.path in ALLOWED))).toEqual([]);
  });

  test.each(Object.entries(ALLOWED))("%s is still the one literal it is excused for", (path, allowed) => {
    expect(exits.filter((exit) => exit.path === path)).toEqual([{ path, code: allowed.code }]);
  });

  test("the pattern sees both spellings, and leaves 0 alone", () => {
    const planted = "process.exit(1);\nprocess.exitCode = 4;\nprocess.exit(0);\nprocess.exit(EXIT.usage);";
    expect([...planted.matchAll(LITERAL_EXIT)].map((match) => match[1] ?? match[2])).toEqual(["1", "4"]);
  });
});

describe("a person's step carries no fix", () => {
  /** `withFix(new PersonRequiredError(` — attaching a runnable remedy to a step only a person may take. */
  const FIXED_PERSON = /withFix\(\s*new PersonRequiredError\b/;

  test("no shipped module attaches one, so the phrase stays out of an agent's reach", () => {
    const offenders = sourcePaths(SRC)
      .filter((path) => FIXED_PERSON.test(blankComments(readSource(path) ?? "")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  test("the pattern catches one", () => {
    expect(FIXED_PERSON.test('throw withFix(new PersonRequiredError({ message: "m" }), { fix: "pithy x" });')).toBe(
      true,
    );
  });

  test("anti-vacuous: fixes are attached somewhere, so the scan reads real source", () => {
    const fixed = sourcePaths(SRC).filter((path) => /\bwithFix\(/.test(blankComments(readSource(path) ?? "")));
    // Few files by design: the provisioning remedies live in `provision/provisionFix.ts`, beside the
    // missing-database ones, rather than at each of the five refusals that attach one.
    expect(fixed.length).toBeGreaterThan(1);
  });
});
