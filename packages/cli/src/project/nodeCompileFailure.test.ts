// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compileSite, nodeCompileFailure, stripOnlySyntax } from "./nodeCompileFailure";

/**
 * Node's own errors, from Node: a config importing `src/kit/tar.ts`, loaded the way the CLI loads one, by a child
 * process. Vitest transforms what this suite imports, so only a separate Node reports what type stripping says.
 */

const CONFIG = 'import * as mid from "./src/mid.ts";\nexport default { capabilities: [], mid };\n';

let dir: string;
let config: string;
let tar: string;

/** What Node throws when `config` imports `tar` holding `source`, as the fields a classifier reads. */
function nodeThrows(source: string, file = tar): Record<string, unknown> {
  writeFileSync(file, source);
  const script = `import(${JSON.stringify(pathToFileURL(config).href)}).then(
    () => console.log("null"),
    (e) => console.log(JSON.stringify({ name: e.name, code: e.code, message: e.message, stack: e.stack })),
  );`;
  try {
    return JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }));
  } finally {
    if (file === config) writeFileSync(config, CONFIG);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-compile-failure-"));
  await mkdir(join(dir, "src", "kit"), { recursive: true });
  config = join(dir, "pithy.config.ts");
  tar = join(dir, "src", "kit", "tar.ts");
  await writeFile(join(dir, "src", "mid.ts"), 'export * from "./kit/tar.ts";\n');
  await writeFile(config, CONFIG);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PARAMETER_PROPERTY =
  "export const a = 1;\n\nexport class Tar {\n  constructor(private readonly name: string) {}\n}\n";
const ENUM = "export const a = 1;\nexport enum Color {\n  Red,\n}\n";
const NAMESPACE = "export namespace Values {\n  export const one = 1;\n}\n";
const IMPORT_EQUALS = 'export const a = 1;\nimport fs = require("node:fs");\n';
const EXPORT_ASSIGNMENT = "const a = 1;\nexport = a;\n";
const ANGLE = "export const a = 1;\nexport const b = <number>a;\n";
const BRACE = "export const a = 1;\nexport const b = {{ 1;\n";

describe("compileSite", () => {
  test("is the file and line Node heads a compile error with", () => {
    expect(compileSite(nodeThrows(PARAMETER_PROPERTY))).toEqual({ file: tar, line: 4 });
    expect(compileSite(nodeThrows(BRACE))).toEqual({ file: tar, line: 2 });
  });

  test("reads a file: URL as a path", () => {
    expect(compileSite({ stack: `${pathToFileURL(tar).href}:3\nexport x\n\nSyntaxError: x` })).toEqual({
      file: tar,
      line: 3,
    });
  });

  test("is nothing for a stack headed by a message, a relative location, or no stack at all", () => {
    expect(compileSite({ stack: "SyntaxError: Unexpected token\n    at file:///a.ts:1:1" })).toBeUndefined();
    expect(compileSite({ stack: "src/kit/tar.ts:4\nexport x" })).toBeUndefined();
    expect(compileSite({ stack: "node:internal/modules/typescript:68\n" })).toBeUndefined();
    expect(compileSite({ message: "no stack" })).toBeUndefined();
    expect(compileSite("a string")).toBeUndefined();
  });
});

describe("stripOnlySyntax", () => {
  test.each([
    [
      PARAMETER_PROPERTY,
      "a TypeScript parameter property",
      "Declare the field in the class and assign it in the constructor.",
    ],
    [ENUM, "a TypeScript enum", "Use an object `as const` and a union of its values."],
    [NAMESPACE, "a TypeScript namespace", "Export its members from the module itself."],
    [IMPORT_EQUALS, "`import =`", "Use an import statement."],
    [EXPORT_ASSIGNMENT, "`export =`", "Use `export default`."],
    [ANGLE, "an angle-bracket type assertion", "Write `value as T`."],
  ])("names what Node refused, and the rewrite: %#", (source, construct, rewrite) => {
    expect(stripOnlySyntax(nodeThrows(source))).toEqual({ construct, rewrite });
  });

  test("names syntax it has no rewrite for, without inventing one", () => {
    expect(
      stripOnlySyntax({
        code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
        message: "TypeScript decorator metadata is not supported in strip-only mode",
      }),
    ).toEqual({
      construct: "TypeScript that does not erase",
      rewrite: "Rewrite it so that removing its types leaves JavaScript.",
    });
  });

  test("is nothing for a parse error, or any other error", () => {
    expect(stripOnlySyntax(nodeThrows(BRACE))).toBeUndefined();
    expect(stripOnlySyntax(new SyntaxError("Unexpected token"))).toBeUndefined();
    expect(stripOnlySyntax(undefined)).toBeUndefined();
  });
});

describe("nodeCompileFailure", () => {
  const isConfig = (file: string) => file === config;

  test("names the imported file, the line, the construct and the rewrite", () => {
    const failure = nodeCompileFailure(nodeThrows(PARAMETER_PROPERTY), { relativeTo: dir, isConfig });
    expect(failure).toEqual({
      kind: "strip-only",
      action:
        "./src/kit/tar.ts, which the config imports, uses a TypeScript parameter property on line 4. Node's type stripping refuses it, and the CLI loads the config that way. Declare the field in the class and assign it in the constructor.",
    });
  });

  test("calls the config the config, when the syntax is its own", () => {
    const failure = nodeCompileFailure(nodeThrows(ENUM, config), { relativeTo: dir, isConfig });
    expect(failure?.action).toMatch(/^The config uses a TypeScript enum on line 2\. /);
    expect(failure?.action).toContain("Use an object `as const` and a union of its values.");
  });

  test("names the imported file that does not parse, and the line", () => {
    const failure = nodeCompileFailure(nodeThrows(BRACE), { relativeTo: dir, isConfig });
    expect(failure?.kind).toBe("parse-error");
    expect(failure?.action).toMatch(
      /^\.\/src\/kit\/tar\.ts, which the config imports, does not parse: Unexpected token `\{`.*\. Line 2\. Fix that file — installing dependencies will not help\.$/,
    );
  });

  test("gives the config's own parse error its line", () => {
    const failure = nodeCompileFailure(nodeThrows(BRACE, config), { relativeTo: dir, isConfig });
    expect(failure?.action).toMatch(
      /^The config does not parse: .*\. Line 2\. Fix the file — installing dependencies will not help\.$/,
    );
  });

  test("shows a file outside the config's directory relative to it", () => {
    const failure = nodeCompileFailure(
      {
        name: "SyntaxError",
        code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
        message: "TypeScript enum is not supported in strip-only mode",
        stack: `${join(dir, "..", "shared", "a.ts")}:7\n`,
      },
      { relativeTo: join(dir, "apps", "api"), isConfig },
    );
    expect(failure?.action).toMatch(
      /^\.\.\/\.\.\/\.\.\/shared\/a\.ts, which the config imports, uses a TypeScript enum on line 7\./,
    );
  });

  test("says the config or a module it imports when Node names no file", () => {
    const failure = nodeCompileFailure(
      { code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", message: "TypeScript enum is not supported in strip-only mode" },
      { relativeTo: dir, isConfig },
    );
    expect(failure?.action).toMatch(
      /^The config or a module it imports uses a TypeScript enum\. Node's type stripping/,
    );
  });

  test("is nothing for an error Node did not raise compiling a file", () => {
    expect(nodeCompileFailure(new Error("boom"), { relativeTo: dir, isConfig })).toBeUndefined();
    expect(
      nodeCompileFailure({ name: "BuildMessage", message: "Unexpected }" }, { relativeTo: dir, isConfig }),
    ).toBeUndefined();
  });
});
