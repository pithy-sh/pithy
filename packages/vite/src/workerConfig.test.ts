// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterAll, describe, expect, test } from "vitest";
import { classifyWorkerConfigFailure, loadWorkerConfig } from "./workerConfig";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workerDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-worker-config-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

async function caught(promise: Promise<unknown>): Promise<PithyError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PithyError);
  return error as PithyError;
}

describe("loadWorkerConfig", () => {
  test("indexes the composed capabilities by name, app included", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        export default {
          capabilities: [
            { name: "auth", requiredBindings: [] },
            { name: "ledger", requiredBindings: [] },
          ],
          app: { name: "api", requiredBindings: [] },
        };
      `,
    });
    const { capabilities } = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect([...capabilities.keys()].sort()).toEqual(["api", "auth", "ledger"]);
  });

  test("loads TypeScript syntax and extensionless relative imports — what a bare import() cannot", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        import { auth } from "./capabilities";
        interface WorkerConfig { capabilities: unknown[] }
        const config: WorkerConfig = { capabilities: [auth] };
        export default config satisfies WorkerConfig;
      `,
      "capabilities.ts": `
        export const auth = { name: "auth", requiredBindings: [] as const };
      `,
    });
    const loaded = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect([...loaded.capabilities.keys()]).toEqual(["auth"]);
    expect(loaded.dependencies.some((file) => file.endsWith("capabilities.ts"))).toBe(true);
  });

  test("a worker with no app capability is fine", async () => {
    const dir = await workerDir({ "pithy.config.ts": "export default { capabilities: [] };" });
    const { capabilities } = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect(capabilities.size).toBe(0);
  });

  test("a missing config names the file and the command that writes it", async () => {
    const dir = await workerDir({});
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.code).toBe("core/not_found");
    expect(error.payload.message).toContain("pithy.config.ts");
    expect(error.payload.action).toContain("pithy ui add");
  });

  test("a config that throws on import is reported with its cause in detail, not as a stack", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'throw new Error("boom");' });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.code).toBe("core/internal");
    expect(error.payload.message).toContain("Could not load");
    expect(error.payload.detail).toContain("boom");
  });

  test("a config without a capabilities array is rejected", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'export default { name: "acme" };' });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.action).toBe("Export default { capabilities, app }.");
  });

  test("a non-capability in the capabilities array is rejected rather than silently skipped", async () => {
    const dir = await workerDir({ "pithy.config.ts": "export default { capabilities: [undefined] };" });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.message).toContain("isn't a capability");
  });
});

/**
 * The refusal for a config that will not load names its cause, or names nothing (#217).
 *
 * The CLI's own loader was fixed in #207; this one built the same `Could not load ${configFile}.` with
 * the same defect — *Fix the config, then run pithy dev again. Run bun install if a `@pithy-sh/*` import
 * did not resolve* — a sentence that hedges by naming both remedies, leads with the wrong one for the
 * commoner failure, and drops the only thing that would have settled it: the reason.
 *
 * The classifier is exported so it is tested against the shapes each runtime throws. `pithy dev` runs
 * this plugin under **Bun**, and `runnerImport` throws Vite's own shapes on top. The classifier reads
 * fields, never the class, so the Bun fixtures are plain objects carrying the fields Bun 1.4.2 throws.
 * The Vite fixtures are what Vite 8.3.0's runner threw, under Node 24 and Bun 1.4.2 alike.
 */
describe("classifyWorkerConfigFailure", () => {
  test("Bun's ResolveMessage, read by its fields: the specifier is named, the referrer is not", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package '@pithy-sh/auth' imported from /home/a/apps/api/pithy.config.ts",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "@pithy-sh/auth",
      referrer: "/home/a/apps/api/pithy.config.ts",
    };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("unresolved-import");
    expect(action).toContain("@pithy-sh/auth");
    expect(action).toMatch(/bun install/i);
    expect(action).not.toContain("/home/a");
  });

  /**
   * **The importer, when the failing import is not the config's own (#480, #489).**
   *
   * The fixture above is the ordinary case: the config's own import, so the referrer is the config and
   * there is nothing to add. This is the other one — `@pithy-sh/email` resolved, and *its* import of core
   * did not — where the specifier alone sends the reader to a package that was fine all along. The dev
   * server loads the same file the CLI does, so it says the same thing.
   */
  test("a dependency's failing import names the dependency, and still never a path", () => {
    const cause = {
      name: "ResolveMessage",
      message: "Cannot find package '@pithy-sh/core' imported from /home/a/node_modules/@pithy-sh/email/src/index.ts",
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "@pithy-sh/core/src/capability/capability",
      referrer: "/home/a/node_modules/@pithy-sh/email/src/index.ts",
    };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("unresolved-import");
    // The import is email's, so email is named as the one that imports it — never the config, never a path.
    expect(action).toMatch(/^@pithy-sh\/email imports /);
    expect(action).not.toContain("/home/a");
    // Nothing is installed at /home/a, and this plugin asks the filesystem: core is absent, so install.
    expect(action).not.toMatch(/will not help/);
    expect(action).toMatch(/bun install/i);
  });

  /**
   * **Three causes, three remedies (#489), on the shapes this loader actually sees.** Installing helps
   * only when a package is absent. The adopter's own missing file, a builtin the runtime does not have,
   * and a package's own missing file are each answered by something an install cannot do.
   */
  describe("which unresolved import it was", () => {
    const viteModule = (specifier: string, importer = "/home/a/apps/api/pithy.config.ts") => ({
      name: "Error",
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find module '${specifier}' imported from '${importer}'`,
      runnerError: {},
    });

    test("a package that is not installed: install, and the specifier is named", () => {
      const { kind, action } = classifyWorkerConfigFailure(viteModule("absentpkg"));
      expect(kind).toBe("unresolved-import");
      expect(action).toContain('"absentpkg"');
      expect(action).toMatch(/bun install/i);
      expect(action).not.toContain("/home/a");
    });

    test("the adopter's own file that is not there: create it, and never install", () => {
      const cause = {
        name: "Error",
        code: "ERR_LOAD_URL",
        message:
          "Failed to load url ./src/x (resolved id: ./src/x) in /home/a/apps/api/pithy.config.ts. Does the file exist?",
        runnerError: {},
      };
      const { kind, action } = classifyWorkerConfigFailure(cause);
      expect(kind).toBe("unresolved-import");
      expect(action).toContain('"./src/x"');
      expect(action).toMatch(/installing dependencies will not help/);
      expect(action).not.toMatch(/bun install/i);
      expect(action).not.toContain("/home/a");
    });

    test("a builtin the runtime does not provide: never install, on Node or on Bun", () => {
      const node = { code: "ERR_UNKNOWN_BUILTIN_MODULE", message: "No such built-in module: node:nope" };
      const bun = {
        name: "ResolveMessage",
        code: "ERR_UNKNOWN_BUILTIN_MODULE",
        message: "No such built-in module: node:nope",
        specifier: "node:nope",
        referrer: "/home/a/node_modules/vite/dist/node/module-runner.js",
      };
      for (const cause of [node, bun]) {
        const { kind, action } = classifyWorkerConfigFailure(cause);
        expect(kind).toBe("unresolved-import");
        expect(action).toContain('"node:nope"');
        expect(action).toMatch(/runtime/);
        expect(action).toMatch(/installing dependencies will not help/);
        expect(action).not.toMatch(/bun install/i);
        expect(action).not.toContain("/home/a");
      }
    });

    test("a relative import that fails inside an installed package: that package's defect, named", () => {
      const bun = {
        name: "ResolveMessage",
        code: "ERR_MODULE_NOT_FOUND",
        message: "Cannot find module './missing.js' imported from /home/a/node_modules/fakepkg/src/index.js",
        specifier: "./missing.js",
        referrer: "/home/a/node_modules/fakepkg/src/index.js",
      };
      // Node hands the resolved path instead, and it is never repeated.
      const node = {
        code: "ERR_MODULE_NOT_FOUND",
        message:
          "Cannot find module '/home/a/node_modules/fakepkg/src/missing.js' imported from /home/a/node_modules/fakepkg/src/index.js",
        url: "file:///home/a/node_modules/fakepkg/src/missing.js",
      };
      for (const cause of [bun, node]) {
        const { kind, action } = classifyWorkerConfigFailure(cause);
        expect(kind).toBe("unresolved-import");
        expect(action).toContain("fakepkg");
        expect(action).toMatch(/installing dependencies will not help/);
        expect(action).not.toMatch(/bun install/i);
        expect(action).not.toContain("/home/a");
      }
    });

    // Node's shapes: the specifier is the already-resolved path, so it is never repeated, and `url` is
    // what says which of the two it was. Neither may fall through to an install.
    test("Node's shape for the adopter's own missing file: create it, never install, and no path", () => {
      const cause = {
        code: "ERR_MODULE_NOT_FOUND",
        message: "Cannot find module '/home/a/apps/api/src/x' imported from /home/a/apps/api/pithy.config.ts",
        url: "file:///home/a/apps/api/src/x",
      };
      const { kind, action } = classifyWorkerConfigFailure(cause);
      expect(kind).toBe("unresolved-import");
      expect(action).toMatch(/Create that file or correct the import/);
      expect(action).toMatch(/installing dependencies will not help/);
      expect(action).not.toMatch(/bun install/i);
      expect(action).not.toContain("/home/a");
    });

    test("Node's shape for a package's missing file the config itself imports: never install, and no path", () => {
      const cause = {
        code: "ERR_MODULE_NOT_FOUND",
        message:
          "Cannot find module '/home/a/node_modules/fakepkg/src/nope.js' imported from /home/a/apps/api/pithy.config.ts",
        url: "file:///home/a/node_modules/fakepkg/src/nope.js",
      };
      const { kind, action } = classifyWorkerConfigFailure(cause);
      expect(kind).toBe("unresolved-import");
      // Named from the package it sits in, never from the path it sits at.
      expect(action).toMatch(/^"fakepkg\/src\/nope\.js" is not something the installed fakepkg provides\./);
      expect(action).toMatch(/installing dependencies will not help/);
      expect(action).not.toMatch(/bun install/i);
      expect(action).not.toContain("/home/a");
    });

    // Vite says `Cannot find module` for a deep import whether its package is absent or only the path is.
    // This plugin used to pass core no probe, so both hedged. It asks the filesystem now, from the config.
    test("a deep import is asked of the filesystem: an install only when the package is absent", async () => {
      const dir = await workerDir({ "pithy.config.ts": "export default {};\n" });
      await mkdir(join(dir, "node_modules", "fakepkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "fakepkg", "package.json"), '{"name":"fakepkg"}');
      const config = join(dir, "pithy.config.ts");

      const installed = classifyWorkerConfigFailure(viteModule("fakepkg/src/nope", config), dir).action;
      expect(installed).toContain('"fakepkg/src/nope"');
      expect(installed).toMatch(/installing dependencies will not help/);
      expect(installed).not.toMatch(/bun install/i);

      const absent = classifyWorkerConfigFailure(viteModule("absentpkg/src/x", config), dir).action;
      expect(absent).toContain('"absentpkg"');
      expect(absent).toMatch(/bun install/i);
      expect(absent).not.toContain(dir);
    });

    // A finding from the last review round: Node's unexported subpath carried no `Cannot find`, so this
    // loader had no specifier and told the adopter to run `bun install` against an installed package.
    test("a subpath the installed package does not export: named, and never an install", () => {
      const cause = {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
        message:
          "Package subpath './hidden.js' is not defined by \"exports\" in /home/a/node_modules/expkg/package.json imported from /home/a/apps/api/pithy.config.ts",
      };
      const { kind, action } = classifyWorkerConfigFailure(cause);
      expect(kind).toBe("unresolved-import");
      expect(action).toContain('"expkg/hidden.js"');
      expect(action).toMatch(/installing dependencies will not help/);
      expect(action).not.toMatch(/bun install/i);
      expect(action).not.toContain("/home/a");
    });
  });

  test("Bun's BuildMessage, read by its fields: the parser's reason reaches the adopter, install does not", () => {
    const cause = {
      name: "BuildMessage",
      message: 'Expected identifier but found "{"',
      position: { file: "/home/a/apps/api/pithy.config.ts", line: 8, column: 3, lineText: "const x = {{" },
    };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain('Expected identifier but found "{"');
    expect(action).toContain("Line 8, column 3");
    expect(action).not.toMatch(/bun install/i);
    expect(action).not.toContain("/home/a");
    expect(action).not.toContain("const x = {{");
  });

  // **Found by running this loader on Bun, not by a fixture.** `import()` on Bun throws an
  // `AggregateError` whose `errors` hold the `BuildMessage`s; its own message is a count and an absolute
  // path. Classifying the wrapper reads a syntax error as "the config threw" and loses the position.
  test("Bun wraps BuildMessages in an AggregateError, and the position still gets through", () => {
    const cause = {
      name: "AggregateError",
      message: '2 errors building "/home/a/apps/api/pithy.config.ts"',
      errors: [
        {
          name: "BuildMessage",
          message: 'Expected identifier but found "{"',
          position: { file: "/home/a/apps/api/pithy.config.ts", line: 1, column: 24, lineText: "const x = {{" },
        },
        { name: "BuildMessage", message: 'Expected "}" but found end of file' },
      ],
    };
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain('Expected identifier but found "{"');
    expect(action).toContain("Line 1, column 24");
    expect(action).not.toContain("/home/a");
  });

  // #709: a line and column in another file, quoted as the config's, sends the adopter to the wrong place.
  test("a position in another file is never quoted as the config's", () => {
    const at = (file: string) => ({
      name: "BuildMessage",
      message: "Unexpected ;",
      position: { file, line: 1, column: 18, lineText: "export const x = ;" },
    });
    const config = "/home/a/apps/api/pithy.config.ts";
    const other = classifyWorkerConfigFailure(at("/home/a/apps/api/src/helpers.ts"), "/home/a/apps/api", config);
    expect(other.action).not.toMatch(/Line \d/);
    expect(classifyWorkerConfigFailure(at(config), "/home/a/apps/api", config).action).toContain("Line 1, column 18");
  });

  test("a config that throws on load gets its own reason, and neither other remedy", () => {
    const { kind, action } = classifyWorkerConfigFailure(new Error("AUTH_SECRET is required"));
    expect(kind).toBe("threw-on-load");
    expect(action).toContain("AUTH_SECRET is required");
    expect(action).not.toMatch(/bun install/i);
  });

  test("an unrecognised cause gets no remedy at all — a wrong action is worse than none", () => {
    const { kind, action } = classifyWorkerConfigFailure({ not: "an error" });
    expect(kind).toBe("unknown");
    expect(action).not.toMatch(/bun install/i);
    expect(action).not.toMatch(/does not parse/i);
  });

  test("a multi-line ANSI diagnostic contributes its position and nothing else", () => {
    const cause = new Error(
      "Transform failed with 1 error:\n\n\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token\n  ╭─[ /a/pithy.config.ts:1:17 ]",
    );
    const { kind, action } = classifyWorkerConfigFailure(cause);
    expect(kind).toBe("parse-error");
    expect(action).toContain("Line 1, column 17");
    expect(action).not.toContain("\n");
    expect(action).not.toContain("/a/pithy.config.ts");
  });

  test("the real loader carries the classified action, and the raw cause only in detail", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'import "@pithy-sh/nope-does-not-exist";\nexport default {};\n' });

    await expect(loadWorkerConfig(join(dir, "pithy.config.ts"))).rejects.toSatisfy((error: PithyError) => {
      expect(error).toBeInstanceOf(PithyError);
      expect(error.payload.action).not.toBe(
        "Fix the config, then run pithy dev again. Run bun install if a @pithy-sh/* import did not resolve.",
      );
      expect(error.payload.detail).toBeTruthy();
      return true;
    });
  });
});
