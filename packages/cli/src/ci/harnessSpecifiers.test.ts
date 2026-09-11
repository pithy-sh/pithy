// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { isTestFile, sourceFiles } from "./sourceFiles";

/**
 * **A program a test writes outside the repository names every import by absolute path.**
 *
 * Two suites drive the real `@clack/prompts` on a real pty, and neither can do it from inside the test
 * process: `password()` renders only on a tty, and the truncation being measured is the terminal's
 * behavior rather than the library's. So each writes a small TypeScript program to a temp directory and
 * runs `bun` on it under `script(1)`.
 *
 * That program sits outside every `node_modules`, so a bare specifier in it has nothing to walk up to and
 * falls through to whatever the machine happens to have. `secretPrompt.pty.test.ts` carried one — `import
 * { z } from "zod"` — and the two ends of that came apart in the worst order:
 *
 * - **On CI it failed loudly**, which was the cheap half: `ENOENT while resolving package 'zod' from
 *   '/tmp/pithy-prompt-pty-…/harness.ts'`, the harness wrote no file, and all five cases reported `the
 *   harness wrote no answer`.
 * - **On a developer machine it passed against the wrong package.** Bun found a globally installed zod —
 *   4.5.4 under `~/.bun/install/global` — while `packages/cli` pins 4.4.3. A suite whose entire purpose is
 *   to establish what a masked prompt and a schema walk actually do was establishing it against a zod the
 *   CLI does not ship, and reporting green while it did.
 *
 * The second is why this is a gate rather than a fixed line. A missing package is a failure anyone can
 * read; a *different* package is a passing test that means nothing, and nothing about the run says so.
 *
 * ## The rule
 *
 * Inside a template literal in a test, an `import … from "…"` whose specifier is a plain string and not
 * `node:*` fails. An interpolated one — `${JSON.stringify(join(CLI_SRC, …))}`, `${JSON.stringify(ZOD)}` —
 * passes, because that is an absolute path resolved from the test file, where resolution is the
 * workspace's. `node:` builtins pass because they resolve nowhere.
 *
 * It reads template literals rather than the harness files themselves for the reason those files are
 * templates: they do not exist until a test runs, and a rule that can only see them at runtime is a rule
 * that runs after the mistake.
 */

/** The repository's `packages/`, from this file at `packages/cli/src/ci/`. */
const PACKAGES = resolve(import.meta.dirname, "..", "..", "..");

/** An `import … from "<specifier>"` whose specifier is a literal, so nothing interpolates into it. */
const LITERAL_IMPORT = /\bimport\b[^;\n]*?\bfrom\s+"([^"$]+)"/g;

/**
 * A template literal bound to a `const` — how both harnesses are written, and the narrowest thing that
 * finds them.
 *
 * **Not "every template literal in the file".** A first cut read backtick to backtick and reported
 * `vite/src/testPlugin.test.ts: vitest/config` — an ordinary import that happened to fall between two
 * backticks quoted in a doc comment. A gate that fails on correct code is one somebody switches off,
 * taking the real assertion with it (`docsCommands.test.ts` says the same thing about prose).
 */
const CONST_TEMPLATE = /const\s+[A-Za-z_$][\w$]*\s*=\s*`([\s\S]*?)`\s*;/g;

/** A program rather than a fragment: something in it is an import, at the start of its own line. */
const IS_PROGRAM = /^import\b/m;

/**
 * Whether the suite hands its program to **Bun**, which is the whole of what makes a bare specifier a bug.
 *
 * Other suites embed a program too and are right to write bare specifiers in it. `vite/src/testPlugin.
 * test.ts` names `virtual:pithy/payments`, which only its own plugin resolves; `ui-react/src/routeGlob.
 * test.ts` writes route fixtures Vite globs; `core/src/entitlement/gateScan.test.ts` embeds source a
 * scanner reads and nothing ever runs. None of those has a resolver walking up from a temp directory, so
 * none of them can pick up whatever the machine happens to have installed.
 *
 * Keyed on how the program is *run* rather than on where it is written, because that is the actual
 * hazard. A second cut keyed on `mkdtemp` and reported all three of the above.
 */
const RUNS_UNDER_BUN = /command -v bun|bunPath\(/;

/** Every embedded program in a suite that runs one — a `const` template that opens a line with `import`. */
function programs(source: string): string[] {
  if (!RUNS_UNDER_BUN.test(source)) return [];
  return [...source.matchAll(CONST_TEMPLATE)].map(([, body]) => body ?? "").filter((body) => IS_PROGRAM.test(body));
}

/** Every bare specifier a file's embedded programs import, as `<file>: <specifier>`. */
function bareSpecifiers(file: string, source: string): string[] {
  const bare: string[] = [];
  for (const program of programs(source)) {
    for (const [, specifier] of program.matchAll(LITERAL_IMPORT)) {
      if (specifier === undefined || specifier.startsWith("node:")) continue;
      bare.push(`${file}: ${specifier}`);
    }
  }
  return bare;
}

/** Every `.test.ts` the walk finds, as `[path relative to `packages/`, text]`. */
function testFiles(): [string, string][] {
  // `keep` is asked for tests: the walk's default is `isShippedSource`, which excludes exactly the files
  // this rule is about. `isTestFile` is the walk's own spelling of the set, so the two cannot drift.
  return sourceFiles(PACKAGES, { keep: isTestFile }).map((file) => [file.path.slice(PACKAGES.length + 1), file.text]);
}

describe("a program a test writes outside the repository", () => {
  test("names every import by absolute path, never by a bare specifier", () => {
    const offenses = testFiles().flatMap(([file, text]) => bareSpecifiers(file, text));

    expect(
      offenses,
      "resolve it from the test file — createRequire(import.meta.url).resolve(…) — and interpolate the path",
    ).toEqual([]);
  });

  // The canary, run before the verdict above is worth anything. That assertion is that a list is empty,
  // and a reader that stopped finding imports, or stopped finding template literals, reports every
  // harness clean. So the detector is proven against a program that does carry one.
  test("catches a bare specifier, and lets an interpolated path and a builtin through", () => {
    const planted = [
      // The line that says this suite runs its program, without which the rule does not apply at all.
      "const BUN = bunPath();",
      "const HARNESS = `",
      'import { writeFileSync } from "node:fs";',
      'import { z } from "zod";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
      "import { readSecretValue } from ${JSON.stringify(entry)};",
      "`;",
    ].join("\n");

    expect(bareSpecifiers("planted.test.ts", planted)).toEqual(["planted.test.ts: zod"]);
  });

  // The other half of the narrowing, asserted rather than described. A suite that embeds a program
  // nothing runs is entitled to a bare specifier — `virtual:pithy/payments` resolves through Vite's own
  // plugin and through nothing else — and a rule that reported it would be a rule somebody turns off.
  test("says nothing about a program no runtime resolves", () => {
    const fixture = ["const MODULE = `", 'import { screen } from "virtual:pithy/payments";', "`;"].join("\n");

    expect(bareSpecifiers("testPlugin.test.ts", fixture)).toEqual([]);
  });

  // The floor, and it is the load-bearing one. The verdict is a sweep and the narrowing above is real, so
  // a `CONST_TEMPLATE` that stopped matching would report every harness clean while the walk still handed
  // back every file. Both suites that write a program are named, and each is asserted to still *contain*
  // one — which is what the rule is about, and what a rename or a rewrite would silently remove.
  test("still finds a program in each of the two suites that writes one", () => {
    const found = new Map(testFiles());
    expect(found.size).toBeGreaterThan(100);

    for (const suite of [
      join("cli", "src", "capabilities", "secretPrompt.pty.test.ts"),
      join("cli", "src", "commands", "secretsInteractive.test.ts"),
    ]) {
      const text = found.get(suite);
      expect(text, `${suite} is where a harness lives`).toBeDefined();
      expect(programs(text as string).length, `${suite} no longer embeds a program`).toBeGreaterThan(0);
    }
  });
});
