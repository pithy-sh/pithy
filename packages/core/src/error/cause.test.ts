// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  causeMessage,
  failurePosition,
  isBuildFailureWrapper,
  prop,
  rootCause,
  safeReason,
  unresolvedSpecifier,
} from "./cause";

/**
 * `rootCause` is one loop, and it is here rather than in three packages because it is not a helper — it
 * is a **recorded fact about a runtime**: Bun wraps two or more build diagnostics in an `AggregateError`.
 * That fact was discovered by #217, missed by #207, and re-found by #223, each time in a different file.
 *
 * These are the unit cases. The proof that Bun still behaves this way is a live import under Bun, in
 * `packages/cli/src/project/config.test.ts` — the CLI is where a real `import()` and Node's typings for
 * spawning one both exist, and core may not touch a Node builtin at all.
 */
describe("rootCause", () => {
  const diagnostic = {
    name: "BuildMessage",
    message: 'Expected identifier but found ";"',
    position: { file: "/home/a/pithy.config.ts", line: 4, column: 1 },
  };

  test("unwraps Bun's AggregateError to the first diagnostic — the rest are the cascade", () => {
    const wrapper = {
      name: "AggregateError",
      message: '4 errors building "/home/a/pithy.config.ts"',
      errors: [diagnostic, { name: "BuildMessage", message: 'Expected "}" but found "default"' }],
    };
    expect(rootCause(wrapper)).toBe(diagnostic);
  });

  test("a bare diagnostic is returned untouched, so one error and four take the same path", () => {
    expect(rootCause(diagnostic)).toBe(diagnostic);
  });

  test("reads a non-enumerable `errors` — Bun's wrapper has no own enumerable keys at all", () => {
    const wrapper: Record<string, unknown> = { name: "AggregateError", message: "2 errors building" };
    Object.defineProperty(wrapper, "errors", { value: [diagnostic], enumerable: false });
    expect(Object.keys(wrapper)).toEqual(["name", "message"]);
    expect(rootCause(wrapper)).toBe(diagnostic);
  });

  test("an empty or absent `errors` is not an unwrap — the value classifies on its own terms", () => {
    const empty = { name: "AggregateError", message: "boom", errors: [] };
    expect(rootCause(empty)).toBe(empty);
    const notAnArray = { errors: "nope" };
    expect(rootCause(notAnArray)).toBe(notAnArray);
    const hole = { errors: [undefined, diagnostic] };
    expect(rootCause(hole)).toBe(hole);
  });

  test("a nested wrapper is unwrapped, and a self-referential one terminates", () => {
    expect(rootCause({ errors: [{ errors: [diagnostic] }] })).toBe(diagnostic);
    const loop: Record<string, unknown> = {};
    loop.errors = [loop];
    expect(rootCause(loop)).toBe(loop);
  });

  test("primitives and null pass straight through", () => {
    expect(rootCause(null)).toBeNull();
    expect(rootCause("boom")).toBe("boom");
    expect(rootCause(undefined)).toBeUndefined();
  });
});

/**
 * The wrapper survives its own diagnostics. Bun caches a failed module and re-throws the `AggregateError`
 * with `errors` gone, so every caller after the first gets the count and the path and nothing else — and
 * on the `pithy doctor` path that is the caller whose sentence an adopter reads.
 */
describe("isBuildFailureWrapper", () => {
  test("recognises the wrapper by its own message, with or without diagnostics attached", () => {
    expect(isBuildFailureWrapper({ name: "AggregateError", message: '4 errors building "/a/x.ts"' })).toBe(true);
    expect(isBuildFailureWrapper({ message: '1 error building "/a/x.ts"' })).toBe(true);
    expect(isBuildFailureWrapper({ message: '2 errors building "/a/x.ts"', errors: [{ name: "BuildMessage" }] })).toBe(
      true,
    );
  });

  test("refuses anything that merely resembles it — the count and the quote are the signature", () => {
    expect(isBuildFailureWrapper({ message: "errors building the account" })).toBe(false);
    expect(isBuildFailureWrapper({ message: 'Something 4 errors building "/a/x.ts"' })).toBe(false);
    expect(isBuildFailureWrapper({ message: "Cannot find package 'zod'" })).toBe(false);
    expect(isBuildFailureWrapper(new Error("boom"))).toBe(false);
    expect(isBuildFailureWrapper(null)).toBe(false);
    expect(isBuildFailureWrapper("4 errors building")).toBe(false);
  });
});

describe("prop", () => {
  test("reads a field off anything object-shaped, `instanceof Error` or not", () => {
    // Bun's BuildMessage is its own class and is NOT an Error. That is the whole reason this exists.
    expect(prop({ name: "BuildMessage" }, "name")).toBe("BuildMessage");
    expect(prop(new Error("boom"), "message")).toBe("boom");
  });

  test("answers undefined for a primitive, for null, and for a missing key — never throws", () => {
    expect(prop(null, "name")).toBeUndefined();
    expect(prop("boom", "name")).toBeUndefined();
    expect(prop(42, "name")).toBeUndefined();
    expect(prop({}, "name")).toBeUndefined();
  });
});

/**
 * The de-coloured message. Escape sequences are formatting a runtime added on its way out, and they are
 * the same formatting in every package that catches one — so they come off here rather than in each.
 */
describe("causeMessage", () => {
  test("reads a message off anything that carries one, `instanceof Error` or not", () => {
    expect(causeMessage({ name: "BuildMessage", message: "Expected identifier" })).toBe("Expected identifier");
    expect(causeMessage(new Error("boom"))).toBe("boom");
  });

  test("strips the colours a runtime paints its diagnostics with", () => {
    expect(causeMessage({ message: "\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token" })).toBe(
      "[PARSE_ERROR] Unexpected token",
    );
  });

  test("answers undefined when there is no string message at all", () => {
    expect(causeMessage({ not: "an error" })).toBeUndefined();
    expect(causeMessage({ message: 42 })).toBeUndefined();
    expect(causeMessage(null)).toBeUndefined();
  });
});

/**
 * **The filter, and there is one of it (#228).**
 *
 * Whether a string may be shown is a property of the string, not of the surface showing it. This lived in
 * three packages, near-verbatim, beside three refusals that genuinely differ — and #223 found a hole in
 * it that had to be patched in all three, by someone who knew all three existed. The refusals stay where
 * they are. The decision is here.
 */
describe("safeReason", () => {
  test("a parser's own one-line reason is safe, and its trailing period is the caller's to add", () => {
    expect(safeReason({ name: "BuildMessage", message: 'Expected identifier but found "{"' })).toBe(
      'Expected identifier but found "{"',
    );
    expect(safeReason(new Error("AUTH_SECRET is required."))).toBe("AUTH_SECRET is required");
  });

  test("reads a value that is not an Error — the whole reason this is duck-typed", () => {
    // Bun's BuildMessage is its own class. An `instanceof Error` gate here passes on Node and drops the
    // parser's sentence on the runtime that ships (#207).
    expect(safeReason({ name: "BuildMessage", message: "Unexpected end of input" })).toBe("Unexpected end of input");
  });

  test("a multi-line diagnostic is throw-site context wearing a message's clothes", () => {
    const boxed = "Transform failed with 1 error:\n\n\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token";
    expect(safeReason({ message: boxed })).toBeUndefined();
  });

  test("anything quoting a path is dropped — POSIX, home-relative, or a Windows drive", () => {
    expect(safeReason({ message: "Cannot find module '/home/a/pithy.config.ts'" })).toBeUndefined();
    expect(safeReason({ message: "failed at ~/projects/app/pithy.config.ts" })).toBeUndefined();
    expect(safeReason({ message: 'Cannot open "C:\\Users\\a\\pithy.config.ts"' })).toBeUndefined();
  });

  test("a stack frame is dropped, and so is nothing and too much", () => {
    expect(safeReason({ message: "boom at module.ts:12:4" })).toBeUndefined();
    expect(safeReason({ message: "   " })).toBeUndefined();
    expect(safeReason({ message: `Expected identifier ${"and more ".repeat(30)}` })).toBeUndefined();
    expect(safeReason({ not: "an error" })).toBeUndefined();
    expect(safeReason(null)).toBeUndefined();
  });

  test("no escape sequence survives, whether or not the sentence itself is safe", () => {
    const reason = safeReason({ message: "\u001b[31mUnexpected token\u001b[0m" });
    expect(reason).toBe("Unexpected token");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: an escape code is exactly what must not leak.
    expect(reason).not.toMatch(/\u001b\[/);
  });

  /**
   * **The #223 suppression, once rather than three times.**
   *
   * Bun's build-failure wrapper is throw-site context in full: a count that is not the adopter's problem
   * and a path that must not travel. It is refused on **provenance** — before a single content test runs —
   * because the content tests exist for a diagnostic that *might* be safe, and this one never is. The leak
   * that proved it: a path Bun quoted without a leading slash sailed through the absolute-path check, and
   * `failurePosition` then dragged a fabricated `Line 12, column 5` out of the file name's own characters.
   */
  test("Bun's build-failure wrapper is refused on provenance, whatever its message happens to look like", () => {
    expect(
      safeReason({ name: "AggregateError", message: '4 errors building "/home/a/pithy.config.ts"' }),
    ).toBeUndefined();
    expect(safeReason({ message: '2 errors building "app/config:12:5.ts"' })).toBeUndefined();
    expect(safeReason({ message: '1 error building "x.ts"' })).toBeUndefined();
  });

  test("prose that merely mentions building is not the wrapper, and keeps its sentence", () => {
    expect(safeReason({ message: "Stripe is still building the account" })).toBe(
      "Stripe is still building the account",
    );
  });
});

/**
 * Where the runtime says the failure was. A fact it recorded — structurally where it can, in its message
 * tail where it cannot — and never a number scraped out of a string that only resembles one.
 */
describe("failurePosition", () => {
  test("the structured position wins, and the file it names is not returned with it", () => {
    const cause = {
      name: "BuildMessage",
      message: 'Expected identifier but found "{"',
      position: { file: "/home/a/pithy.config.ts", line: 8, column: 3, lineText: "const x = {{" },
    };
    expect(failurePosition(cause)).toEqual({ line: 8, column: 3 });
  });

  test("falls back to the runtime's own `…:LINE:COL`, lifting the two numbers and not the path", () => {
    expect(failurePosition({ message: "  ╭─[ /a/pithy.config.ts:1:17 ]" })).toEqual({ line: 1, column: 17 });
  });

  test("a position that is not one is not invented", () => {
    expect(failurePosition({ message: "Unexpected token" })).toBeUndefined();
    expect(failurePosition({ position: { line: 0, column: 0 } })).toBeUndefined();
    expect(failurePosition({ position: "somewhere" })).toBeUndefined();
    expect(failurePosition(null)).toBeUndefined();
  });

  test("the build-failure wrapper yields no position — the one that was fabricated from a file name", () => {
    expect(failurePosition({ message: '2 errors building "app/config:12:5.ts"' })).toBeUndefined();
    expect(
      failurePosition({ name: "AggregateError", message: '4 errors building "/home/a/x.ts:9:2"' }),
    ).toBeUndefined();
  });
});

/** The specifier that did not resolve — the adopter's own import, never the referrer around it. */
describe("unresolvedSpecifier", () => {
  test("the field is preferred, because the prose around it names our frame", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package 'stripe' from '/p/node_modules/@pithy-sh/payments/src/capability.ts'",
      specifier: "stripe",
    };
    expect(unresolvedSpecifier(cause)).toBe("stripe");
  });

  test("Node states it in prose, and only the quoted specifier is taken out of it", () => {
    expect(unresolvedSpecifier({ message: "Cannot find package '@pithy-sh/auth' imported from /a/b.ts" })).toBe(
      "@pithy-sh/auth",
    );
    expect(unresolvedSpecifier({ message: 'Cannot find module "./missing" imported from /a/b.ts' })).toBe("./missing");
  });

  test("nothing to name is undefined, and an empty field is nothing", () => {
    expect(unresolvedSpecifier({ message: "Failed to resolve module" })).toBeUndefined();
    expect(unresolvedSpecifier({ specifier: "" })).toBeUndefined();
    expect(unresolvedSpecifier(null)).toBeUndefined();
  });
});
