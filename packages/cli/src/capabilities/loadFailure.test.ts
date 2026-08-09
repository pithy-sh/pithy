// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { capabilityLoadError, classifyCapabilityLoadFailure } from "./loadFailure";

/**
 * The loader classifier, against the error shapes each runtime actually throws.
 *
 * The CLI's `bin` runs on **Bun**, whose `ResolveMessage` and `BuildMessage` are their own classes and
 * are **not** `instanceof Error`. #207's first draft gated on `instanceof Error`, passed all 32 tests
 * under vitest (which runs on Node), and dropped the parser's own sentence on the shipping runtime. So
 * the Bun fixtures here are plain objects, as they really are — never `new Error(...)`.
 */
describe("classifyCapabilityLoadFailure", () => {
  test("the capability's own package does not resolve: `pithy add` is the remedy, and it is earned", () => {
    const cause = Object.assign(new Error("Cannot find package '@pithy-sh/payments' imported from /a/b.ts"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const { kind, message, action } = classifyCapabilityLoadFailure("payments", "@pithy-sh/payments", cause);
    expect(kind).toBe("not-installed");
    expect(message).toBe("The payments capability is not installed.");
    expect(action).toContain("pithy add payments");
  });

  test("Bun's ResolveMessage is not an Error, and the capability is still recognised as absent", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package '@pithy-sh/vector' from '/home/a/x.ts'",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "@pithy-sh/vector",
      referrer: "/home/a/x.ts",
    };
    const { kind, action } = classifyCapabilityLoadFailure("vector", "@pithy-sh/vector", cause);
    expect(kind).toBe("not-installed");
    expect(action).toContain("pithy add vector");
  });

  // The whole of #217, one level down the graph: the capability IS installed, and one of its own
  // transitive dependencies is not. `pithy add <cap>` is the one command that cannot fix this.
  test("a transitive dependency does not resolve: never `pithy add`, and the specifier is named", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package 'stripe' from '/p/node_modules/@pithy-sh/payments/src/capability.ts'",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "stripe",
      referrer: "/p/node_modules/@pithy-sh/payments/src/capability.ts",
    };
    const { kind, message, action } = classifyCapabilityLoadFailure("payments", "@pithy-sh/payments", cause);
    expect(kind).toBe("dependency-unresolved");
    expect(message).not.toMatch(/is not installed/);
    expect(action).not.toMatch(/pithy add/);
    expect(action).toContain("stripe");
    expect(action).toMatch(/bun install/i);
    // The referrer is our frame, not the adopter's import. It never travels in `action`.
    expect(action).not.toContain("/p/node_modules");
  });

  test("Bun's ResolveMessage carries the specifier as a field, and the prose path is not read", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package 'node:sqlite' from '/home/a/node_modules/@pithy-sh/support/src/x.ts'",
      specifier: "node:sqlite",
    };
    const { kind, action } = classifyCapabilityLoadFailure("support", "@pithy-sh/support", cause);
    expect(kind).toBe("dependency-unresolved");
    expect(action).toContain("node:sqlite");
    expect(action).not.toContain("/home/a");
  });

  test("a subpath the installed package does not export is broken, not absent", () => {
    const cause = Object.assign(new Error("Package subpath './src/capability' is not defined by \"exports\""), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      specifier: "@pithy-sh/media/src/capability",
    });
    const { kind, action } = classifyCapabilityLoadFailure("media", "@pithy-sh/media", cause);
    expect(kind).toBe("broken");
    expect(action).not.toMatch(/pithy add/);
    expect(action).toMatch(/reinstall/i);
  });

  test("Bun's BuildMessage is not an Error: an installed package that will not parse is broken", () => {
    const cause = {
      name: "BuildMessage",
      message: 'Expected identifier but found "{"',
      position: { file: "/p/node_modules/@pithy-sh/storage/src/capability.ts", line: 12, column: 3 },
    };
    const { kind, message, action } = classifyCapabilityLoadFailure("storage", "@pithy-sh/storage", cause);
    expect(kind).toBe("broken");
    expect(message).not.toMatch(/is not installed/);
    expect(action).not.toMatch(/pithy add/);
    expect(action).toContain('Expected identifier but found "{"');
    expect(action).not.toContain("/p/node_modules");
  });

  test("an installed package that throws on load is broken, and its own reason is carried", () => {
    const cause = new Error("PAYMENTS_CONFIG is required");
    const { kind, action } = classifyCapabilityLoadFailure("payments", "@pithy-sh/payments", cause);
    expect(kind).toBe("broken");
    expect(action).toContain("PAYMENTS_CONFIG is required");
    expect(action).not.toMatch(/pithy add/);
  });

  test("an unresolved import with no nameable specifier hedges across both causes", () => {
    const cause = new Error("Failed to resolve module");
    const { kind, action } = classifyCapabilityLoadFailure("testers", "@pithy-sh/testers", cause);
    expect(kind).toBe("unresolved-import");
    // Both remedies, neither asserted — the classifier cannot tell which package failed.
    expect(action).toMatch(/pithy add testers/);
    expect(action).toMatch(/bun install/i);
  });

  test("an unrecognised cause gets no single remedy — a wrong action is worse than none", () => {
    const { kind, action } = classifyCapabilityLoadFailure("vector", "@pithy-sh/vector", { not: "an error" });
    expect(kind).toBe("unknown");
    expect(action).not.toMatch(/^Run `pithy add/);
    expect(action).toMatch(/pithy doctor|check/i);
  });

  // **Found by running the real CLI on Bun, not by a fixture.** Bun does not throw a `BuildMessage` from
  // `import()` — it throws an `AggregateError` whose `errors` hold them, and whose own message is a count
  // and an absolute path. Classifying the wrapper reads it as "the package threw", loses the parser's
  // sentence, and is #207's trap wearing a different hat. Verified against Bun 1.3.14.
  test("Bun wraps BuildMessages in an AggregateError, and the parser's sentence still gets through", () => {
    const cause = {
      name: "AggregateError",
      message: '2 errors building "/p/node_modules/@pithy-sh/storage/src/capability.ts"',
      errors: [
        {
          name: "BuildMessage",
          message: 'Expected identifier but found "{"',
          position: { file: "/p/node_modules/@pithy-sh/storage/src/capability.ts", line: 1, column: 24 },
        },
        { name: "BuildMessage", message: 'Expected "}" but found end of file' },
      ],
    };
    const { kind, action } = classifyCapabilityLoadFailure("storage", "@pithy-sh/storage", cause);
    expect(kind).toBe("broken");
    expect(action).toContain('Expected identifier but found "{"');
    expect(action).toMatch(/does not parse/);
    expect(action).not.toContain("/p/node_modules");
  });

  test("an AggregateError wrapping a ResolveMessage is still a resolution failure", () => {
    const cause = {
      name: "AggregateError",
      message: '1 error building "/p/x.ts"',
      errors: [{ name: "ResolveMessage", message: "Cannot find package 'stripe'", specifier: "stripe" }],
    };
    const { kind, action } = classifyCapabilityLoadFailure("payments", "@pithy-sh/payments", cause);
    expect(kind).toBe("dependency-unresolved");
    expect(action).toContain("stripe");
  });

  test("a multi-line ANSI diagnostic contributes nothing quotable to action", () => {
    const cause = new Error(
      "Transform failed with 1 error:\n\n[31m[PARSE_ERROR] [0mUnexpected token\n  ╭─[ /p/x.ts:1:17 ]",
    );
    const { action } = classifyCapabilityLoadFailure("storage", "@pithy-sh/storage", cause);
    expect(action).not.toContain("\n");
    expect(action).not.toContain("/p/x.ts");
  });
});

describe("capabilityLoadError", () => {
  test("the target reaches detail and never action — detail is throw-site context", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package 'stripe' from '/p/node_modules/@pithy-sh/payments/src/x.ts'",
      specifier: "stripe",
    };
    const error = capabilityLoadError("payments", "@pithy-sh/payments/src/capability", cause);
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.detail).toContain("@pithy-sh/payments/src/capability");
    expect(error.payload.detail).toContain("dependency-unresolved");
    expect(error.payload.action).not.toContain("@pithy-sh/payments/src/capability");
    expect(error.cause).toBe(cause);
  });

  test("the capability package is derived from the target, so a deep subpath still classifies", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package '@pithy-sh/testers/src/workflows/worker'",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "@pithy-sh/testers/src/workflows/worker",
    };
    const error = capabilityLoadError("testers", "@pithy-sh/testers/src/workflows/worker", cause);
    expect(error.payload.message).toBe("The testers capability is not installed.");
    expect(error.payload.action).toContain("pithy add testers");
  });
});
