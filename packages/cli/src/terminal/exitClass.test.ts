// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorPayload, KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import {
  ConflictError,
  InputRequiredError,
  NotFoundError,
  PersonRequiredError,
  PithyError,
  PreconditionFailedError,
  UpstreamError,
  UpstreamTimeoutError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  canceled,
  EXIT,
  EXIT_CLASS_BY_CODE,
  EXIT_CLASSES,
  ExitClass,
  exitClassOf,
  exitCodeOf,
  fixOf,
  withFix,
} from "./exitClass";

/**
 * **One exit code per kind of failure, and one kind per error code (#697).**
 *
 * Every failure used to exit 1, so a bad flag, a project nobody provisioned, a Cloudflare outage and a
 * step only a person may take all looked the same to a script. These hold the table that tells them
 * apart: every kit code has exactly one class, the classes have the numbers `docs/CLI.md` publishes, and
 * a remedy (`fix`) never rides on a step that is a person's.
 */

describe("the classes", () => {
  test("have the numbers docs/CLI.md publishes", () => {
    expect(EXIT).toEqual({
      ok: 0,
      failed: 1,
      usage: 2,
      precondition: 3,
      upstream: 4,
      person: 5,
      interrupted: 130,
      brokenPipe: 141,
    });
  });

  test("each class row carries its own number, and only upstream is retryable", () => {
    for (const name of ExitClass.options) {
      expect(EXIT_CLASSES[name].exit).toBe(EXIT[name]);
      expect(EXIT_CLASSES[name].retryable).toBe(name === "upstream");
    }
  });

  test("the five failure classes are five distinct numbers, none of them 0, 130 or 141", () => {
    const numbers = ExitClass.options.map((name) => EXIT[name]);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).not.toContain(EXIT.ok);
    expect(numbers).not.toContain(EXIT.interrupted);
    expect(numbers).not.toContain(EXIT.brokenPipe);
  });
});

describe("every kit error code maps to exactly one class", () => {
  const kitCodes = KitErrorPayload.options.map((member) => member.shape.code.value).sort();

  test("the table's codes are exactly the codes in KitErrorPayload — no code unclassified, none stale", () => {
    expect(Object.keys(EXIT_CLASS_BY_CODE).sort()).toEqual(kitCodes);
  });

  test("anti-vacuous: the taxonomy is the size it is", () => {
    expect(kitCodes.length).toBeGreaterThan(100);
  });

  test.each(kitCodes)("%s has one class from the closed set", (code) => {
    expect(ExitClass.safeParse(EXIT_CLASS_BY_CODE[code as keyof typeof EXIT_CLASS_BY_CODE]).success).toBe(true);
  });

  test("the codes the issue names land where it says", () => {
    expect(EXIT_CLASS_BY_CODE["validation/invalid_input"]).toBe("usage");
    expect(EXIT_CLASS_BY_CODE["input/required"]).toBe("usage");
    expect(EXIT_CLASS_BY_CODE["core/precondition_failed"]).toBe("precondition");
    expect(EXIT_CLASS_BY_CODE["core/not_found"]).toBe("precondition");
    expect(EXIT_CLASS_BY_CODE["core/upstream_failed"]).toBe("upstream");
    expect(EXIT_CLASS_BY_CODE["core/upstream_timeout"]).toBe("upstream");
    expect(EXIT_CLASS_BY_CODE["core/person_required"]).toBe("person");
    expect(EXIT_CLASS_BY_CODE["secrets/rotation_unrecorded"]).toBe("person");
    expect(EXIT_CLASS_BY_CODE["core/internal"]).toBe("failed");
  });
});

describe("exitClassOf / exitCodeOf", () => {
  test("a thrown error's payload exits by its class", () => {
    expect(exitCodeOf(new ValidationError().payload)).toBe(2);
    expect(exitCodeOf(new InputRequiredError({ flag: "--worker" }).payload)).toBe(2);
    expect(exitCodeOf(new PreconditionFailedError().payload)).toBe(3);
    expect(exitCodeOf(new NotFoundError().payload)).toBe(3);
    expect(exitCodeOf(new ConflictError().payload)).toBe(3);
    expect(exitCodeOf(new UpstreamError().payload)).toBe(4);
    expect(exitCodeOf(new UpstreamTimeoutError().payload)).toBe(4);
    expect(exitCodeOf(new PersonRequiredError().payload)).toBe(5);
  });

  test("an adopter's own code is unclassified, so it exits 1 rather than borrowing a meaning", () => {
    const adopter = ErrorPayload.parse({ code: "billing/card_declined", status: 402, message: "Declined." });
    expect(exitClassOf(adopter)).toBe("failed");
    expect(exitCodeOf(adopter)).toBe(1);
  });
});

describe("fix: a runnable remedy, carried beside the error rather than inside its payload", () => {
  test("withFix attaches it and returns the same error, so a throw site stays one expression", () => {
    const error = new PreconditionFailedError({ message: "Not provisioned." });
    expect(withFix(error, { fix: "pithy provision --env staging --yes" })).toBe(error);
    expect(fixOf(error)).toBe("pithy provision --env staging --yes");
  });

  test("an error nobody gave a fix has none", () => {
    expect(fixOf(new ValidationError())).toBeUndefined();
  });

  test("a person's step never carries one — the phrase stays out of an agent's reach", () => {
    const error = withFix(new PersonRequiredError(), { fix: "pithy provision --env prod --confirm x" });
    expect(fixOf(error)).toBeUndefined();
  });

  test("a fix must be a pithy command, because an agent runs it as one", () => {
    expect(() => withFix(new PreconditionFailedError(), { fix: "Run provision first." })).toThrow(PithyError);
  });
});

describe("canceled", () => {
  afterEach(() => vi.restoreAllMocks());

  test("says so on stderr and exits 130, the shell's number for an interrupt", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => canceled()).toThrow("exited");
    expect(stderr).toHaveBeenCalledWith("Canceled.\n");
    expect(exit).toHaveBeenCalledWith(130);
  });
});

/**
 * **`docs/CLI.md` §3.8 is this table, row for row.** The page is what a script author reads, and a number
 * that drifted from the code there is a script testing for the wrong thing.
 */
describe("docs/CLI.md §3.8", () => {
  const page = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "docs", "CLI.md"), "utf8");
  const start = page.indexOf("### 3.8 Exit codes");
  const section = page.slice(start, page.indexOf("\n## ", start));

  /** `| \`2\` | \`usage\` | Usage or validation | Fix the call |`, by class. */
  const rows = new Map(
    [...section.matchAll(/^\| `(\d+)` \| `([a-z]+)` \| ([^|]+) \| ([^|]+) \|$/gm)].map((match) => [
      match[2],
      { exit: Number(match[1]), meaning: match[3]?.trim(), agentShould: match[4]?.trim() },
    ]),
  );

  test("the section exists", () => {
    expect(start).toBeGreaterThan(-1);
  });

  test.each(ExitClass.options)("states %s with the code, meaning and remedy the CLI uses", (name) => {
    const { exit, meaning, agentShould } = EXIT_CLASSES[name];
    expect(rows.get(name)).toEqual({ exit, meaning, agentShould });
  });

  test("states 0, 130 and 141 too, and tells a script to test non-zero rather than 1", () => {
    expect(section).toContain(`| \`${EXIT.ok}\` | — | Done | Continue |`);
    expect(section).toContain(`| \`${EXIT.interrupted}\` | — | Interrupted | Stop |`);
    expect(section).toContain(`| \`${EXIT.brokenPipe}\` | — | Output closed early | Read what arrived |`);
    expect(section).toContain("A script should test for non-zero, not for `1`.");
  });
});
