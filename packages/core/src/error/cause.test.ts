// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { isBuildFailureWrapper, prop, rootCause } from "./cause";

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
