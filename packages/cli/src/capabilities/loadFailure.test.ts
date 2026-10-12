// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { EXIT, exitCodeOf, fixOf } from "../terminal/exitClass";
import { capabilityLoadError, capabilityLoadErrorNow, classifyCapabilityLoadFailure } from "./loadFailure";

/**
 * The loader classifier, against the error shapes each runtime actually throws.
 *
 * The CLI's `bin` runs on **Bun**, and vitest runs on Node. The classifier reads fields alone, never the
 * class, so the Bun fixtures here are plain objects carrying the fields Bun 1.4.2 throws, never
 * `new Error(...)`. A gate on the class fails them, which is the point: #207's first draft gated on it.
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

  test("Bun's ResolveMessage, read by its fields: the capability is still recognized as absent", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package '@pithy-sh/vector' imported from /home/a/x.ts",
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
      message: "Cannot find package 'stripe' imported from /p/node_modules/@pithy-sh/payments/src/capability.ts",
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

  // Bun 1.4.2 writes one sentence, `Cannot find package '<pkg>' imported from <referrer>`, for a deep import
  // whether `<pkg>` is absent or installed without that path, and the `specifier` field is the same in both.
  // Only the filesystem tells them apart. These fixtures are what Bun 1.4.2 threw with @pithy-sh/core
  // installed beside @pithy-sh/email; the project below stages exactly that tree.
  describe("an import the runtime cannot tell apart, asked of the filesystem (Bun 1.4.2)", () => {
    const root = mkdtempSync(join(tmpdir(), "pithy-load-failure-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    for (const pkg of ["core", "email"]) {
      mkdirSync(join(root, "node_modules", "@pithy-sh", pkg, "src"), { recursive: true });
      writeFileSync(join(root, "node_modules", "@pithy-sh", pkg, "package.json"), `{"name":"@pithy-sh/${pkg}"}`);
    }
    const referrer = join(root, "node_modules", "@pithy-sh", "email", "src", "capability.ts");
    const bun = (specifier: string, sentence = "package") => ({
      name: "ResolveMessage",
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find ${sentence} '${specifier}' imported from ${referrer}`,
      specifier,
      referrer,
    });

    test("a deep import into a dependency that is installed and lacks the path is broken, never an install", () => {
      const cause = bun("@pithy-sh/core/src/new/thing");
      const { kind, message, action } = classifyCapabilityLoadFailure("email", "@pithy-sh/email", cause, root);
      expect(kind).toBe("broken");
      expect(message).not.toMatch(/is not installed/);
      expect(action).toContain('"@pithy-sh/core/src/new/thing"');
      expect(action).toMatch(/@pithy-sh\/email/);
      expect(action).toMatch(/installing dependencies will not help/);
      expect(action).not.toMatch(/bun install|pithy add/i);
      expect(action).not.toContain(root);
    });

    test("the capability's own `#` import is its package's defect, never an install", () => {
      const cause = bun("#internal/x");
      const { kind, message, action } = classifyCapabilityLoadFailure("email", "@pithy-sh/email", cause, root);
      expect(kind).toBe("broken");
      expect(message).not.toMatch(/is not installed/);
      expect(action).toContain('"#internal/x"');
      expect(action).toMatch(/@pithy-sh\/email imports/);
      expect(action).toMatch(/imports map/);
      expect(action).toMatch(/installing dependencies will not help/);
      expect(action).not.toMatch(/bun install|pithy add/i);
      expect(action).not.toContain(root);
    });

    test("a deep import into a dependency that is genuinely absent still earns the install", () => {
      const cause = bun("@pithy-sh/absent/src/thing");
      const { kind, action } = classifyCapabilityLoadFailure("email", "@pithy-sh/email", cause, root);
      expect(kind).toBe("dependency-unresolved");
      expect(action).toMatch(/^@pithy-sh\/email imports "@pithy-sh\/absent", which is not installed\./);
      expect(action).toMatch(/bun install/);
      expect(action).not.toMatch(/pithy add/);
    });

    test("a deep import with no referrer to look from hedges: both remedies, neither asserted", () => {
      const { referrer: _, ...cause } = bun("@pithy-sh/core/src/new/thing");
      const message = cause.message.replace(/ imported from .*$/, "");
      const { kind, action } = classifyCapabilityLoadFailure("email", "@pithy-sh/email", { ...cause, message }, root);
      expect(kind).toBe("dependency-unresolved");
      expect(action).toMatch(/bun install/);
      expect(action).toMatch(/correct that import/);
      expect(action).not.toMatch(/will not help|pithy add/);
    });
  });

  // Measured on Bun 1.4.2: `node:nope` throws ERR_UNKNOWN_BUILTIN_MODULE with the specifier as written.
  // Under Node 22 the same `node:nope` carries the code and the sentence alone, and `bun:nope` is a scheme
  // Node has no loader for. The runtime provides these, so no install ever will. (Bun 1.4.2 itself drops
  // the scheme from `bun:nope` and reports a package called `nope`; nothing in that cause is left to read.)
  test("a builtin the runtime does not provide is never an install, on Bun or on Node", () => {
    const referrer = "/home/a/node_modules/@pithy-sh/support/src/x.ts";
    const causes = [
      {
        name: "ResolveMessage",
        code: "ERR_UNKNOWN_BUILTIN_MODULE",
        message: "No such built-in module: node:nope",
        specifier: "node:nope",
        referrer,
      },
      Object.assign(new Error("No such built-in module: node:nope"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" }),
      Object.assign(
        new Error(
          "Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'bun:'",
        ),
        { code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" },
      ),
    ];
    for (const cause of causes) {
      const { kind, message, action } = classifyCapabilityLoadFailure("support", "@pithy-sh/support", cause, "/home/a");
      expect(kind).toBe("broken");
      expect(message).not.toMatch(/is not installed/);
      expect(action).toMatch(/runtime/);
      expect(action).toMatch(/"(?:node:nope|bun:)"/);
      expect(action).not.toMatch(/bun install|pithy add/i);
      expect(action).not.toContain("/home/a");
    }
  });

  test("a subpath the installed package does not export is broken, not absent", () => {
    const cause = Object.assign(new Error("Package subpath './src/capability' is not defined by \"exports\""), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      specifier: "@pithy-sh/media/src/capability",
    });
    const { kind, action } = classifyCapabilityLoadFailure("media", "@pithy-sh/media", cause);
    expect(kind).toBe("broken");
    expect(action).not.toMatch(/pithy add|bun install/);
    expect(action).toContain(
      '"@pithy-sh/media/src/capability" is not something the installed @pithy-sh/media provides.',
    );
    expect(action).toMatch(/installing dependencies will not help/);
  });

  test("Bun's BuildMessage, read by its fields: an installed package that will not parse is broken", () => {
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

  // **Found by running the real CLI on Bun, not by a fixture.** Bun throws a `BuildMessage` bare from
  // `import()` only when there is one; two or more arrive in an `AggregateError` whose `errors` hold them,
  // and whose own message is a count and an absolute path. Classifying the wrapper reads it as "the package threw", loses the parser's
  // sentence, and is #207's trap wearing a different hat. Verified against Bun 1.4.2.
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
      errors: [
        {
          name: "ResolveMessage",
          code: "ERR_MODULE_NOT_FOUND",
          message: "Cannot find package 'stripe' imported from /p/node_modules/@pithy-sh/payments/src/x.ts",
          specifier: "stripe",
          referrer: "/p/node_modules/@pithy-sh/payments/src/x.ts",
        },
      ],
    };
    const { kind, action } = classifyCapabilityLoadFailure("payments", "@pithy-sh/payments", cause);
    expect(kind).toBe("dependency-unresolved");
    expect(action).toContain("stripe");
  });

  test("a multi-line ANSI diagnostic contributes nothing quotable to action", () => {
    const cause = new Error(
      "Transform failed with 1 error:\n\n\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token\n  ╭─[ /p/x.ts:1:17 ]",
    );
    const { action } = classifyCapabilityLoadFailure("storage", "@pithy-sh/storage", cause);
    expect(action).not.toContain("\n");
    expect(action).not.toContain("/p/x.ts");
  });
});

describe("capabilityLoadError", () => {
  test("the target reaches detail and never action — detail is throw-site context", async () => {
    const cause = {
      name: "ResolveMessage",
      code: "ERR_MODULE_NOT_FOUND",
      message: "Cannot find package 'stripe' imported from /p/node_modules/@pithy-sh/payments/src/x.ts",
      specifier: "stripe",
      referrer: "/p/node_modules/@pithy-sh/payments/src/x.ts",
    };
    const error = await capabilityLoadError("payments", "@pithy-sh/payments/src/capability", cause);
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.detail).toContain("@pithy-sh/payments/src/capability");
    expect(error.payload.detail).toContain("dependency-unresolved");
    expect(error.payload.action).not.toContain("@pithy-sh/payments/src/capability");
    expect(error.cause).toBe(cause);
  });

  const missingTesters = {
    name: "ResolveMessage",
    message: "Cannot find package '@pithy-sh/testers' imported from /p/apps/api/x.ts",
    code: "ERR_MODULE_NOT_FOUND",
    specifier: "@pithy-sh/testers/src/workflows/worker",
    referrer: "/p/apps/api/x.ts",
  };

  test("the capability package is derived from the target, so a deep subpath still classifies", async () => {
    const error = await capabilityLoadError("testers", "@pithy-sh/testers/src/workflows/worker", missingTesters);
    expect(error.payload.message).toBe("The testers capability is not installed.");
    expect(error.payload.action).toContain("pithy add testers");
  });

  // A capability the project never installed is one it does not compose: the call was right, the project is
  // missing what it depends on. Exit 3 and `pithy add` as the fix, as `notComposed.ts` answers it — never exit
  // 2, which says a different spelling would have worked (#697, docs/CLI.md §3.8).
  describe("a capability that is not installed is a precondition, with pithy add as its fix", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pithy-load-failure-"));
      await mkdir(join(dir, "apps", "api"), { recursive: true });
      await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), JSON.stringify({ name: "demo-api" }));
      await writeFile(join(dir, "apps", "api", "pithy.config.ts"), "export default {};\n");
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("exit 3, core/precondition_failed, and the add that installs and composes it", async () => {
      const error = await capabilityLoadError("testers", "@pithy-sh/testers", missingTesters, dir);
      expect(error.payload.code).toBe("core/precondition_failed");
      expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
      expect(fixOf(error)).toBe("pithy add testers --with-prerequisites");
      expect(error.cause).toBe(missingTesters);
    });

    test("two Workers and nothing saying which: still exit 3, and no fix", async () => {
      await mkdir(join(dir, "apps", "admin"), { recursive: true });
      await writeFile(join(dir, "apps", "admin", "wrangler.jsonc"), JSON.stringify({ name: "demo-admin" }));
      await writeFile(join(dir, "apps", "admin", "pithy.config.ts"), "export default {};\n");
      const error = await capabilityLoadError("testers", "@pithy-sh/testers", missingTesters, dir);
      expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
      expect(fixOf(error)).toBeUndefined();
    });

    test("the synchronous form is the same class, with no fix", () => {
      const error = capabilityLoadErrorNow("testers", "@pithy-sh/testers", missingTesters, dir);
      expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
      expect(fixOf(error)).toBeUndefined();
    });

    test("every other kind stays a usage error", async () => {
      const cause = { name: "SyntaxError", message: "Unexpected token" };
      const error = await capabilityLoadError("testers", "@pithy-sh/testers", cause, dir);
      expect(error.payload.code).toBe("validation/invalid_input");
    });
  });
});
