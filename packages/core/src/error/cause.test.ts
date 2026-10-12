// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  causeMessage,
  failurePosition,
  importingPackage,
  prop,
  rootCause,
  safeReason,
  unresolvedKind,
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

describe("prop", () => {
  test("reads a field off anything object-shaped, `instanceof Error` or not", () => {
    // A cause is `unknown`. Bun 1.3's BuildMessage was not an Error and 1.4's is; the read is the same.
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
 * The de-colored message. Escape sequences are formatting a runtime added on its way out, and they are
 * the same formatting in every package that catches one — so they come off here rather than in each.
 */
describe("causeMessage", () => {
  test("reads a message off anything that carries one, `instanceof Error` or not", () => {
    expect(causeMessage({ name: "BuildMessage", message: "Expected identifier" })).toBe("Expected identifier");
    expect(causeMessage(new Error("boom"))).toBe("boom");
  });

  test("strips the colors a runtime paints its diagnostics with", () => {
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
    // A cause is `unknown`, and an `instanceof Error` gate is a claim about a runtime's classes. Bun 1.3's
    // BuildMessage broke that claim and shipped #207; the filter reads fields, so no class can break it.
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
});

/** The specifier that did not resolve — the adopter's own import, never the referrer around it. */
describe("unresolvedSpecifier", () => {
  test("the field is preferred, because the prose around it names our frame", () => {
    const cause = {
      name: "ResolveMessage",
      code: "ERR_MODULE_NOT_FOUND",
      message: "Cannot find package 'stripe' imported from /p/node_modules/@pithy-sh/payments/src/capability.ts",
      specifier: "stripe",
      referrer: "/p/node_modules/@pithy-sh/payments/src/capability.ts",
    };
    expect(unresolvedSpecifier(cause)).toBe("stripe");
  });

  test("Node states it in prose, and only the quoted specifier is taken out of it", () => {
    expect(unresolvedSpecifier({ message: "Cannot find package '@pithy-sh/auth' imported from /a/b.ts" })).toBe(
      "@pithy-sh/auth",
    );
    expect(unresolvedSpecifier({ message: 'Cannot find module "./missing" imported from /a/b.ts' })).toBe("./missing");
  });

  // Measured on Vite 8.3.0's `runnerImport`, under Node 24 and Bun 1.4.2 alike: a relative import that is
  // not there is Vite's own sentence, and a missing builtin under Node carries no field at all.
  test("Vite's module runner and Node's builtin loader state it in their own sentences", () => {
    expect(
      unresolvedSpecifier({
        code: "ERR_LOAD_URL",
        message:
          "Failed to load url ./src/x (resolved id: ./src/x) in /p/apps/api/pithy.config.ts. Does the file exist?",
      }),
    ).toBe("./src/x");
    expect(
      unresolvedSpecifier({ code: "ERR_UNKNOWN_BUILTIN_MODULE", message: "No such built-in module: node:nope" }),
    ).toBe("node:nope");
  });

  test("nothing to name is undefined, and an empty field is nothing", () => {
    expect(unresolvedSpecifier({ message: "Failed to resolve module" })).toBeUndefined();
    expect(unresolvedSpecifier({ specifier: "" })).toBeUndefined();
    expect(unresolvedSpecifier(null)).toBeUndefined();
  });
});

/**
 * **Which of three causes an unresolved import was — measured on Bun 1.4.2 and Node 24 (#489, #709).**
 *
 * Bun 1.4 writes Node's sentence for every bare specifier that fails, `Cannot find package '<name>'
 * imported from <path>`, whether the package is absent or only the subpath is. So the sentence cannot
 * keep an install away from an installed package's missing subpath, which is the remedy #489 exists to
 * keep away. Bun's `specifier` field is what tells them apart, and the fixtures below are what 1.4.2
 * threw, paths shortened.
 */
describe("unresolvedKind", () => {
  /** A Bun 1.4.2 `ResolveMessage`, as measured: the sentence names the package, the field the import. */
  function bun(specifier: string, named: string, referrer = "/p/apps/api/pithy.config.ts") {
    return {
      name: "ResolveMessage",
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find package '${named}' imported from ${referrer}`,
      specifier,
      referrer,
      importKind: "import-statement",
    };
  }

  test("Bun: a package that is not installed is a package", () => {
    expect(unresolvedKind(bun("absentpkg", "absentpkg"))).toBe("package");
    expect(unresolvedKind(bun("@pithy-sh/auth", "@pithy-sh/auth"))).toBe("package");
  });

  // The regression. Bun 1.4.2 says `Cannot find package 'fakepkg'` for `fakepkg/src/nope` whether `fakepkg`
  // is installed or not, and the field is the same in both. The shape cannot tell them apart, so it does not
  // pretend to: the caller's probe asks the filesystem, from the file the import was written in.
  test("Bun: a bare specifier with a path is a subpath only when its package is installed", () => {
    const seen: string[][] = [];
    const installed = (pkg: string, referrer: string) => {
      seen.push([pkg, referrer]);
      return pkg !== "absentpkg";
    };
    expect(unresolvedKind(bun("fakepkg/src/nope", "fakepkg"), installed)).toBe("package-subpath");
    expect(unresolvedKind(bun("@pithy-sh/core/src/capability/capability", "@pithy-sh/core"), installed)).toBe(
      "package-subpath",
    );
    expect(unresolvedKind(bun("absentpkg/src/x", "absentpkg"), installed)).toBe("package");
    expect(seen).toEqual([
      ["fakepkg", "/p/apps/api/pithy.config.ts"],
      ["@pithy-sh/core", "/p/apps/api/pithy.config.ts"],
      ["absentpkg", "/p/apps/api/pithy.config.ts"],
    ]);
  });

  // #480's shape: a fresh clone, or a kit package whose own dependency is not linked. Every kit import is a
  // deep path, so this is the common case, and calling it a subpath tells the adopter not to install.
  test("Bun: with no probe, a bare specifier with a path cannot be told, and says so", () => {
    expect(unresolvedKind(bun("@pithy-sh/core/src/capability/capability", "@pithy-sh/core"))).toBeUndefined();
    expect(unresolvedKind(bun("fakepkg/src/nope", "fakepkg"))).toBeUndefined();
    // A bare name alone is the package itself, and needs no probe.
    expect(unresolvedKind(bun("absentpkg", "absentpkg"))).toBe("package");
  });

  test("Bun: with no referrer to probe from, a bare specifier with a path cannot be told", () => {
    const cause = { name: "ResolveMessage", message: "Cannot find package 'fakepkg'", specifier: "fakepkg/src/nope" };
    expect(unresolvedKind(cause, () => true)).toBeUndefined();
  });

  test("Bun: a relative import is the adopter's own file", () => {
    const cause = {
      ...bun("./src/x", "./src/x"),
      message: "Cannot find module './src/x' imported from /p/apps/api/pithy.config.ts",
    };
    expect(unresolvedKind(cause)).toBe("local-file");
    expect(unresolvedKind(bun("../shared/x", "../shared/x"))).toBe("local-file");
    expect(unresolvedKind(bun("C:\\p\\src\\x", "C:\\p\\src\\x"))).toBe("local-file");
    // A path written into an installed package is that package's missing file, not the adopter's.
    expect(unresolvedKind(bun("/p/node_modules/pkg/src/x", "/p/node_modules/pkg/src/x"))).toBe("package-subpath");
  });

  // Measured on 1.4.2: `pkg2/index.js` imports `./nope.js`, and Bun names that file as the referrer.
  test("Bun: a relative import that fails inside an installed package is that package's defect", () => {
    const cause = {
      ...bun("./nope.js", "./nope.js", "/p/node_modules/pkg2/index.js"),
      message: "Cannot find module './nope.js' imported from /p/node_modules/pkg2/index.js",
    };
    expect(unresolvedKind(cause)).toBe("package-subpath");
    expect(unresolvedKind(bun("../x", "../x", "/p/node_modules/.bun/a@1/node_modules/a/src/i.ts"))).toBe(
      "package-subpath",
    );
  });

  // Measured on 1.4.2: a `#` import the imports map does not satisfy reads `Cannot find package '#x'`, and
  // the field carries it as written, `#internal/x` included.
  test("Bun: a # import is its importer's own imports map, the adopter's or the package's", () => {
    expect(unresolvedKind(bun("#internal", "#internal"))).toBe("local-file");
    expect(unresolvedKind(bun("#internal/x", "#internal"))).toBe("local-file");
    expect(unresolvedKind(bun("#own", "#own", "/p/node_modules/pkg3/index.js"))).toBe("package-subpath");
    // Never a package, so never an install, and never a probe.
    expect(unresolvedKind(bun("#internal/x", "#internal"), () => false)).toBe("local-file");
  });

  // Bun 1.4.2 hands a file URL over already converted to a path. A runtime that does not is read the same.
  test("Bun: a file URL is a path, not a package called file:", () => {
    expect(unresolvedKind(bun("file:///p/src/x.ts", "file:"))).toBe("local-file");
    expect(unresolvedKind(bun("file:///p/node_modules/pkg/src/x.ts", "file:"))).toBe("package-subpath");
    expect(unresolvedKind(bun("/p/src/x.ts", "/p/src/x.ts"))).toBe("local-file");
  });

  // Measured on 1.4.2: `node:nope` and `node:fs/promsies` throw ERR_UNKNOWN_BUILTIN_MODULE, `bun:nope` throws
  // `Cannot find package 'bun:nope'`, and the field carries each as written. The runtime provides these.
  test("Bun: a builtin scheme is the runtime's, never a package to install", () => {
    const builtin = (specifier: string, referrer = "/p/apps/api/pithy.config.ts") => ({
      name: "ResolveMessage",
      code: "ERR_UNKNOWN_BUILTIN_MODULE",
      message: `No such built-in module: ${specifier}`,
      specifier,
      referrer,
    });
    expect(unresolvedKind(builtin("node:nope"))).toBe("package-subpath");
    expect(unresolvedKind(builtin("node:nope"), () => false)).toBe("package-subpath");
    expect(unresolvedKind(builtin("node:fs/promsies"), () => false)).toBe("package-subpath");
    expect(unresolvedKind(bun("bun:nope", "bun:nope"), () => false)).toBe("package-subpath");
    // A drive letter is not a scheme: a Windows path is still judged by where it points.
    expect(unresolvedKind(bun("C:\\p\\src\\x.ts", "C:\\p\\src\\x.ts"))).toBe("local-file");
  });

  test("Node: the sentence decides, and a resolved path under node_modules is a subpath", () => {
    expect(
      unresolvedKind({ code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package 'pkg' imported from /p/a.ts" }),
    ).toBe("package");
    expect(
      unresolvedKind({
        code: "ERR_MODULE_NOT_FOUND",
        message: "Cannot find module '/p/node_modules/pkg/src/nope.js' imported from /p/a.ts",
        url: "file:///p/node_modules/pkg/src/nope.js",
      }),
    ).toBe("package-subpath");
    expect(
      unresolvedKind({
        code: "ERR_MODULE_NOT_FOUND",
        message: "Cannot find module '/p/apps/board/src/x' imported from /p/apps/board/pithy.config.ts",
        url: "file:///p/apps/board/src/x",
      }),
    ).toBe("local-file");
  });

  // A `file:` URL whose escapes do not decode is still a path. It is judged by the specifier as written.
  test("a file URL that will not decode is read as written, never thrown", () => {
    expect(unresolvedKind(bun("file:///p/src/%E0.ts", "file:"))).toBe("local-file");
    expect(unresolvedKind(bun("file:///p/node_modules/pkg/%E0.ts", "file:"))).toBe("package-subpath");
  });

  /**
   * Vite 8.3.0's `runnerImport`, measured under Node 24 and Bun 1.4.2: the same shapes on both. It says
   * `Cannot find module` for a bare specifier **as written**, absent or installed alike, and quotes the
   * importer. A relative file that is not there is its own `ERR_LOAD_URL` sentence. No field, no `url`.
   */
  describe("Vite's module runner", () => {
    const vite = (specifier: string, importer = "/p/apps/api/pithy.config.ts") => ({
      name: "Error",
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find module '${specifier}' imported from '${importer}'`,
      runnerError: {},
    });

    test("a bare name alone is the package itself", () => {
      expect(unresolvedKind(vite("absentpkg"))).toBe("package");
      expect(unresolvedKind(vite("@pithy-sh/auth"))).toBe("package");
    });

    test("a bare name with a path is asked of the probe, from the importer it quoted", () => {
      const seen: string[][] = [];
      const installed = (pkg: string, referrer: string) => {
        seen.push([pkg, referrer]);
        return pkg === "fakepkg";
      };
      expect(unresolvedKind(vite("fakepkg/src/nope"), installed)).toBe("package-subpath");
      expect(unresolvedKind(vite("absentpkg/src/x"), installed)).toBe("package");
      expect(seen).toEqual([
        ["fakepkg", "/p/apps/api/pithy.config.ts"],
        ["absentpkg", "/p/apps/api/pithy.config.ts"],
      ]);
      // Core has no filesystem. With no probe the two cannot be told apart, and it says so.
      expect(unresolvedKind(vite("fakepkg/src/nope"))).toBeUndefined();
    });

    test("a relative file that is not there is the adopter's, or the package's it was written in", () => {
      const missing = (importer: string) => ({
        name: "Error",
        code: "ERR_LOAD_URL",
        message: `Failed to load url ./src/x (resolved id: ./src/x) in ${importer}. Does the file exist?`,
        runnerError: {},
      });
      expect(unresolvedKind(missing("/p/apps/api/pithy.config.ts"))).toBe("local-file");
      expect(unresolvedKind(missing("/p/node_modules/pkg2/index.js"))).toBe("package-subpath");
      expect(importingPackage(missing("/p/node_modules/pkg2/index.js"))).toBe("pkg2");
    });

    // Under Node the builtin loader throws before Vite's runner sees it: a code and a sentence, nothing else.
    test("a builtin that does not exist is the runtime's, never a package to install", () => {
      const cause = { code: "ERR_UNKNOWN_BUILTIN_MODULE", message: "No such built-in module: node:nope" };
      expect(unresolvedKind(cause)).toBe("package-subpath");
      expect(unresolvedKind(cause, () => false)).toBe("package-subpath");
    });
  });

  test("nothing to read is undefined", () => {
    expect(unresolvedKind({ message: "Failed to resolve module" })).toBeUndefined();
    expect(unresolvedKind(null)).toBeUndefined();
  });
});

/**
 * The package the failing import was written in — the half #480's refusal threw away.
 *
 * The fixtures are the two runtimes' real shapes, both measured on the layout that produced #480: a
 * config importing `@pithy-sh/email/src/index`, and `@pithy-sh/email`'s own import of core failing.
 */
describe("importingPackage", () => {
  /** Bun 1.4.2, verbatim but for the path, for exactly the tree #480 hit. */
  const BUN = {
    name: "ResolveMessage",
    code: "ERR_MODULE_NOT_FOUND",
    message: "Cannot find package '@pithy-sh/core' imported from /p/node_modules/@pithy-sh/email/src/index.ts",
    specifier: "@pithy-sh/core/src/capability/capability",
    referrer: "/p/node_modules/@pithy-sh/email/src/index.ts",
    importKind: "import-statement",
  };

  test("Bun carries the referrer as a field, and its package half is what comes back", () => {
    expect(importingPackage(BUN)).toBe("@pithy-sh/email");
  });

  test("Node states it in prose, at the end of its sentence", () => {
    expect(
      importingPackage({
        code: "ERR_MODULE_NOT_FOUND",
        message: "Cannot find package '@pithy-sh/core' imported from /p/node_modules/@pithy-sh/email/src/index.js",
      }),
    ).toBe("@pithy-sh/email");
  });

  test("Vite's module runner quotes it, and the quotes are not part of the path", () => {
    expect(
      importingPackage({
        code: "ERR_MODULE_NOT_FOUND",
        message: "Cannot find module '@pithy-sh/core/src/x' imported from '/p/node_modules/kysely'",
      }),
    ).toBe("kysely");
  });

  test("an unscoped package is named without inventing a scope", () => {
    expect(importingPackage({ referrer: "/p/node_modules/kysely/dist/index.js" })).toBe("kysely");
  });

  // Every store nests, and the owner is the last one. Both layouts measured, on pnpm and on Bun 1.4.2.
  test("the innermost node_modules wins, so a content-addressed store names the package and not its id", () => {
    expect(importingPackage({ referrer: "/p/node_modules/.pnpm/hono@4.6.3/node_modules/hono/dist/index.js" })).toBe(
      "hono",
    );
    expect(
      importingPackage({
        referrer: "/p/node_modules/.bun/@pithy-sh+email@0.1.4/node_modules/@pithy-sh/email/src/i.ts",
      }),
    ).toBe("@pithy-sh/email");
    expect(importingPackage({ referrer: "/p/node_modules/a/node_modules/b/index.js" })).toBe("b");
  });

  test("a Windows path is a path too", () => {
    expect(importingPackage({ referrer: "C:\\p\\node_modules\\@pithy-sh\\email\\src\\index.ts" })).toBe(
      "@pithy-sh/email",
    );
  });

  /**
   * The whole point of the function: a name, never a path. The adopter's own config is where an
   * unresolved import usually lives, and the refusal already names that file — so there is nothing to
   * add, and a path is the one thing that must not be added.
   */
  test("the adopter's own file is nothing to name, not a path to print", () => {
    expect(importingPackage({ referrer: "/home/a/apps/board/pithy.config.ts" })).toBeUndefined();
    expect(importingPackage({ message: "Cannot find package 'x' imported from /home/a/pithy.config.ts" })).toBe(
      undefined,
    );
  });

  test("a store's own bookkeeping directory is not a package", () => {
    expect(importingPackage({ referrer: "/p/node_modules/.bun/hono@4.6.3/x.js" })).toBeUndefined();
    expect(importingPackage({ referrer: "/p/node_modules/hono@4.6.3/x.js" })).toBeUndefined();
    expect(importingPackage({ referrer: "/p/node_modules/" })).toBeUndefined();
  });

  test("nothing to read is undefined, and an empty field is nothing", () => {
    expect(importingPackage({ message: "Failed to resolve module" })).toBeUndefined();
    expect(importingPackage({ referrer: "" })).toBeUndefined();
    expect(importingPackage(null)).toBeUndefined();
  });
});
