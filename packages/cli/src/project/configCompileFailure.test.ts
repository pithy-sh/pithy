// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { classifyConfigLoadFailure } from "./config";

/**
 * A Worker config that Node will not compile, because a module two imports away holds a parameter property, loaded
 * by the built CLI's own `loadWorkerConfig` in a separate Node: the refusal names that module, its line, the
 * construct and the rewrite.
 */

const CONFIG_MODULE = resolve(import.meta.dirname, "..", "..", "dist", "project", "config.js");

let dir: string;
let worker: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-config-compile-"));
  worker = join(dir, "apps", "api");
  await mkdir(join(worker, "src", "collect", "kit"), { recursive: true });
  await writeFile(
    join(worker, "pithy.config.ts"),
    'import { collect } from "./src/collect/index.ts";\nexport default { capabilities: [], collect };\n',
  );
  await writeFile(
    join(worker, "src", "collect", "index.ts"),
    'import { Tar } from "./kit/tar.ts";\nexport const collect = new Tar("a");\n',
  );
  await writeFile(
    join(worker, "src", "collect", "kit", "tar.ts"),
    "export class Tar {\n  constructor(private readonly name: string) {}\n  get label(): string {\n    return this.name;\n  }\n}\n",
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a config whose import Node's type stripping refuses", () => {
  test("names the file, the line, the construct and the rewrite", () => {
    const script = `const { loadWorkerConfig } = await import(${JSON.stringify(pathToFileURL(CONFIG_MODULE).href)});
      await loadWorkerConfig(${JSON.stringify(worker)}).then(
        () => console.log("null"),
        (e) => console.log(JSON.stringify(e.payload)),
      );`;
    const payload = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }));
    expect(payload.message).toBe(`Could not load ${join(worker, "pithy.config.ts")}.`);
    expect(payload.action).toBe(
      "./src/collect/kit/tar.ts, which the config imports, uses a TypeScript parameter property on line 2. Node's type stripping refuses it, and the CLI loads the config that way. Declare the field in the class and assign it in the constructor.",
    );
    expect(payload.detail).toMatch(/^strip-only: /);
  });
});

describe("classifyConfigLoadFailure, on Node's compile errors", () => {
  const config = join(tmpdir(), "acme", "apps", "api", "pithy.config.ts");
  const tar = join(tmpdir(), "acme", "apps", "api", "src", "tar.ts");

  test("a strip-only refusal is its own kind", () => {
    const { kind, action } = classifyConfigLoadFailure(
      {
        name: "SyntaxError",
        code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
        message: "TypeScript enum is not supported in strip-only mode",
        stack: `${tar}:3\nexport enum E { A }\n\nSyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode\n    at parseTypeScript (node:internal/modules/typescript:68:40)`,
      },
      join(tmpdir(), "acme", "apps", "api"),
      config,
    );
    expect(kind).toBe("strip-only");
    expect(action).toMatch(/^\.\/src\/tar\.ts, which the config imports, uses a TypeScript enum on line 3\. /);
  });

  test("an imported file that does not parse is named, rather than the config", () => {
    const { kind, action } = classifyConfigLoadFailure(
      {
        name: "SyntaxError",
        code: "ERR_INVALID_TYPESCRIPT_SYNTAX",
        message: "Expression expected",
        stack: `${tar}:1\nexport const a = 1 +;\n\nSyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected\n    at parseTypeScript (node:internal/modules/typescript:72:36)`,
      },
      join(tmpdir(), "acme", "apps", "api"),
      config,
    );
    expect(kind).toBe("parse-error");
    expect(action).toBe(
      "./src/tar.ts, which the config imports, does not parse: Expression expected. Line 1. Fix that file — installing dependencies will not help.",
    );
  });
});

describe("classifyConfigLoadFailure, on Bun's parse errors", () => {
  const root = join(tmpdir(), "acme", "apps", "api");
  const config = join(root, "pithy.config.ts");
  const at = (file: string) => ({
    name: "BuildMessage",
    message: "Unexpected ;",
    position: { file, line: 1, column: 20, lineText: "export const a = 1 +;" },
  });

  test("an imported file that does not parse is named, with its line and column, rather than the config", () => {
    const { kind, action } = classifyConfigLoadFailure(at(join(root, "src", "tar.ts")), root, config);
    expect(kind).toBe("parse-error");
    expect(action).toBe(
      "./src/tar.ts, which the config imports, does not parse: Unexpected ;. Line 1, column 20. Fix that file — installing dependencies will not help.",
    );
  });

  test("Bun's diagnostic inside an AggregateError names the file too", () => {
    const wrapped = new AggregateError([at(join(root, "src", "tar.ts"))], "1 error building");
    expect(classifyConfigLoadFailure(wrapped, root, config).action).toMatch(/^\.\/src\/tar\.ts, which the config/);
  });

  test("the config's own parse error stays the config's", () => {
    expect(classifyConfigLoadFailure(at(config), root, config).action).toBe(
      "The config does not parse: Unexpected ;. Line 1, column 20. Fix the file — installing dependencies will not help.",
    );
  });

  test("what Bun's import() really throws for an imported file that does not parse names that file", async () => {
    const staged = await mkdtemp(join(tmpdir(), "pithy-bun-parse-"));
    try {
      await mkdir(join(staged, "src"));
      const own = join(staged, "pithy.config.ts");
      await writeFile(own, 'import { a } from "./src/tar.ts";\nexport default { capabilities: [], a };\n');
      await writeFile(join(staged, "src", "tar.ts"), "// first line\nexport const a = 1 +;\n");
      const classifier = pathToFileURL(resolve(import.meta.dirname, "config.ts")).href;
      const script = [
        `import { classifyConfigLoadFailure } from ${JSON.stringify(classifier)};`,
        `const [dir, config] = process.argv.slice(2);`,
        `try { await import(config); console.log("null"); }`,
        `catch (e) { console.log(JSON.stringify(classifyConfigLoadFailure(e, dir, config))); }`,
      ].join("\n");
      // Beside the staged tree, never in it, so the probe is never a file the config could import.
      const scripts = await mkdtemp(join(tmpdir(), "pithy-bun-parse-probe-"));
      const scriptFile = join(scripts, "probe.ts");
      await writeFile(scriptFile, script);
      try {
        const said = JSON.parse(execFileSync("bun", [scriptFile, staged, own], { encoding: "utf8" }));
        expect(said.kind).toBe("parse-error");
        expect(said.action).toMatch(/^\.\/src\/tar\.ts, which the config imports, does not parse/);
        expect(said.action).toContain("Line 2, column");
        expect(said.action).not.toContain(staged);
      } finally {
        await rm(scripts, { recursive: true, force: true });
      }
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });

  test("a file Bun names by a relative path is not guessed at", () => {
    const { action } = classifyConfigLoadFailure(at("src/tar.ts"), root, config);
    expect(action).toBe(
      "The config does not parse: Unexpected ;. Fix the file — installing dependencies will not help.",
    );
  });
});
