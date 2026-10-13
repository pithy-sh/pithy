// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { importingPackage, nodeModulesProbe, unresolvedImport } from "./unresolved";

/**
 * The one classifier for an import that would not resolve (#709), unit by unit.
 *
 * Every shape below was measured on Bun 1.4.2 and Node 22.23.3 (Node 24.21.0 throws the same), importing
 * a real tree, and shortened to `/p`. What the three surfaces say about the same causes, on disk, is
 * `packages/cli/src/project/unresolvedSurfaces.test.ts`; this file holds the classifier to each branch.
 */
const ROOT = "/p";
const CONFIG = "/p/apps/api/pithy.config.ts";

/** A Bun 1.4.2 `ResolveMessage`: the field is the import as written, the sentence names a package. */
function bun(specifier: string, sentence: string, referrer = CONFIG, code = "ERR_MODULE_NOT_FOUND") {
  return { name: "ResolveMessage", code, message: `${sentence} imported from ${referrer}`, specifier, referrer };
}

/** A Node 22 `ERR_MODULE_NOT_FOUND`: the sentence alone, plus the resolved `url` for a module. */
function node(message: string, url?: string, code = "ERR_MODULE_NOT_FOUND") {
  return url === undefined ? { name: "Error", code, message } : { name: "Error", code, message, url };
}

/** Whatever is installed, by name. The real probe walks `node_modules`; this one is the answer. */
const has =
  (...installed: string[]) =>
  (pkg: string) =>
    installed.includes(pkg);

describe("unresolvedImport", () => {
  describe("what it recognizes", () => {
    test("every resolution failure both runtimes throw, and nothing else", () => {
      for (const code of [
        "ERR_MODULE_NOT_FOUND",
        "MODULE_NOT_FOUND",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "ERR_UNSUPPORTED_DIR_IMPORT",
        "ERR_UNKNOWN_BUILTIN_MODULE",
        "ERR_PACKAGE_IMPORT_NOT_DEFINED",
        "ERR_UNSUPPORTED_ESM_URL_SCHEME",
      ]) {
        expect(unresolvedImport({ code, message: "x" }), code).toBeDefined();
      }
      expect(unresolvedImport({ name: "ResolveMessage", message: "x" })).toBeDefined();
      expect(unresolvedImport({ message: "Failed to resolve import x" })).toBeDefined();
      expect(unresolvedImport({ message: "No such built-in module: node:nope" })).toBeDefined();

      expect(unresolvedImport(new Error("PAYMENTS_CONFIG is required"))).toBeUndefined();
      expect(unresolvedImport({ name: "BuildMessage", message: 'Expected identifier but found "{"' })).toBeUndefined();
      expect(unresolvedImport(null)).toBeUndefined();
      expect(unresolvedImport("Cannot find module")).toBeUndefined();
    });

    test("Bun's AggregateError is opened first, so a wrapped resolution failure is still one", () => {
      const wrapped = { name: "AggregateError", message: '1 error building "/p/x.ts"', errors: [bun("stripe", "x")] };
      expect(unresolvedImport(wrapped)?.kind).toBe("package");
    });
  });

  describe("an absent package", () => {
    test("is the package, and installing is the remedy — on Bun and on Node", () => {
      const fromBun = unresolvedImport(bun("absentpkg", "Cannot find package 'absentpkg'"));
      const fromNode = unresolvedImport(node(`Cannot find package 'absentpkg' imported from ${CONFIG}`));
      for (const found of [fromBun, fromNode]) {
        expect(found?.kind).toBe("package");
        expect(found?.package).toBe("absentpkg");
        expect(found?.installHelps).toBe(true);
        expect(found?.remedy).toBe(
          '"absentpkg" is not installed. Install the project\'s dependencies (bun install), or correct that import.',
        );
      }
    });

    // Bun 1.4.2 names the deep import in its field; Node names only the package in its sentence. The
    // remedy names the package, which is the half both runtimes give, so it reads the same on both.
    test("a deep import into it reads the same on both runtimes, once the probe says it is absent", () => {
      const fromBun = unresolvedImport(bun("absentpkg/src/x", "Cannot find package 'absentpkg'"), {
        installed: has(),
      });
      const fromNode = unresolvedImport(node(`Cannot find package 'absentpkg' imported from ${CONFIG}`));
      expect(fromBun?.remedy).toBe(fromNode?.remedy);
    });

    test("a dependency's absent dependency names the dependency that imports it", () => {
      const referrer = "/p/node_modules/@pithy-sh/payments/src/capability.js";
      const found = unresolvedImport(bun("stripe", "Cannot find package 'stripe'", referrer));
      expect(found?.owner).toBe("@pithy-sh/payments");
      expect(found?.remedy).toBe(
        '@pithy-sh/payments imports "stripe", which is not installed. Install the project\'s dependencies (bun install). If it is still missing, @pithy-sh/payments does not declare it — report that to its maintainer.',
      );
    });
  });

  describe("an installed package without the path", () => {
    // The regression #709 found. Bun 1.4.2 writes `Cannot find package 'fakepkg'` for `fakepkg/src/nope`
    // whether `fakepkg` is there or not, so the probe is what keeps an install away from it.
    test("Bun: asked of the probe, from the file the import was written in", () => {
      const seen: string[][] = [];
      const installed = (pkg: string, referrer: string) => {
        seen.push([pkg, referrer]);
        return pkg === "fakepkg";
      };
      expect(unresolvedImport(bun("fakepkg/src/nope", "Cannot find package 'fakepkg'"), { installed })?.kind).toBe(
        "package-subpath",
      );
      expect(unresolvedImport(bun("@sc/pk/src/nope", "Cannot find package '@sc/pk'"), { installed })?.kind).toBe(
        "package",
      );
      expect(seen).toEqual([
        ["fakepkg", CONFIG],
        ["@sc/pk", CONFIG],
      ]);
    });

    test("Node: the resolved path under node_modules settles it, and reads the same as Bun", () => {
      const fromNode = unresolvedImport(
        node(
          `Cannot find module '/p/node_modules/fakepkg/src/nope' imported from ${CONFIG}`,
          "file:///p/node_modules/fakepkg/src/nope",
        ),
        { relativeTo: ROOT },
      );
      const fromBun = unresolvedImport(bun("fakepkg/src/nope", "Cannot find package 'fakepkg'"), {
        installed: has("fakepkg"),
        relativeTo: ROOT,
      });
      expect(fromNode?.kind).toBe("package-subpath");
      expect(fromNode?.shown).toBe("fakepkg/src/nope");
      expect(fromNode?.remedy).toBe(fromBun?.remedy);
      expect(fromNode?.installHelps).toBe(false);
      expect(fromNode?.remedy).toBe(
        '"fakepkg/src/nope" is not something the installed fakepkg provides. Check the version of fakepkg you have, or correct that import — installing dependencies will not help.',
      );
    });

    // Bun 1.4.2 cannot tell an unexported subpath from a missing one: the same sentence, the same field.
    // Node can. The remedy is one sentence for both, so the runtime an adopter runs does not change it.
    test("an unexported subpath is the same remedy as a missing one, on Node's own shape", () => {
      const fromNode = unresolvedImport(
        node(
          `Package subpath './hidden.js' is not defined by "exports" in /p/node_modules/expkg/package.json imported from ${CONFIG}`,
          undefined,
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
        ),
      );
      const fromBun = unresolvedImport(bun("expkg/hidden.js", "Cannot find package 'expkg'"), {
        installed: has("expkg"),
      });
      expect(fromNode?.kind).toBe("package-subpath");
      expect(fromNode?.package).toBe("expkg");
      expect(fromNode?.shown).toBe("expkg/hidden.js");
      expect(fromNode?.remedy).toBe(fromBun?.remedy);
    });

    // The vite surface used to say `bun install` here: the sentence carried no `Cannot find`, so it had no
    // specifier, and with no specifier it fell through to the install. CommonJS `require.resolve` says it
    // with no `imported from`, and a field where the loader added one.
    test("an unexported subpath with no importer still names what was asked for", () => {
      const found = unresolvedImport({
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
        message:
          "Package subpath './src/capability' is not defined by \"exports\" in /p/node_modules/@pithy-sh/media/package.json",
      });
      expect(found?.kind).toBe("package-subpath");
      expect(found?.shown).toBe("@pithy-sh/media/src/capability");
      expect(found?.remedy).not.toMatch(/bun install/);
      expect(found?.remedy).not.toContain("/p/");
    });

    test("a dependency asking another for a path it lacks names both, and never an install", () => {
      const referrer = "/p/node_modules/@pithy-sh/email/src/capability.js";
      const found = unresolvedImport(
        bun("@pithy-sh/core/src/new/thing", "Cannot find package '@pithy-sh/core'", referrer),
        {
          installed: has("@pithy-sh/core"),
        },
      );
      expect(found?.remedy).toBe(
        '@pithy-sh/email imports "@pithy-sh/core/src/new/thing", which the installed @pithy-sh/core does not provide. Bring @pithy-sh/email and @pithy-sh/core to matching versions, or report this to its maintainer — installing dependencies will not help.',
      );
    });
  });

  // The must-fix of #709's first review: a bare name went straight to "not installed", ahead of the probe.
  // Bun 1.4.2 says `Cannot find package 'pkg'` for an installed package with no entry at its bare name —
  // an `exports` map with no ".", which is every @pithy-sh/* package, or a `main` naming a missing file.
  describe("an installed package with no entry at its bare name", () => {
    const NO_ENTRY =
      "The installed nodot has no entry to import by its bare name. Import one of its paths, or check the version of nodot you have — installing dependencies will not help.";

    test("Bun: the probe finds it, so it is the package's entry, never an install", () => {
      const seen: string[][] = [];
      const installed = (pkg: string, referrer: string) => {
        seen.push([pkg, referrer]);
        return pkg === "nodot";
      };
      const found = unresolvedImport(bun("nodot", "Cannot find package 'nodot'"), { installed });
      expect(found).toEqual({
        kind: "package-subpath",
        package: "nodot",
        shown: "nodot",
        installHelps: false,
        remedy: NO_ENTRY,
      });
      expect(seen).toEqual([["nodot", CONFIG]]);
    });

    test("Bun: the probe does not find it, so it is absent and installing is the remedy", () => {
      const found = unresolvedImport(bun("nodot", "Cannot find package 'nodot'"), { installed: has() });
      expect(found?.kind).toBe("package");
      expect(found?.installHelps).toBe(true);
    });

    test("with no probe, or no referrer to probe from, a bare name is taken as absent", () => {
      const noProbe = unresolvedImport(bun("nodot", "Cannot find package 'nodot'"));
      const noReferrer = unresolvedImport(
        { name: "ResolveMessage", message: "Cannot find package 'nodot'", specifier: "nodot" },
        { installed: has("nodot") },
      );
      for (const found of [noProbe, noReferrer]) expect(found?.kind).toBe("package");
    });

    test('Node: an exports map with no "." names the package, and reads the same as Bun', () => {
      const found = unresolvedImport(
        node(
          `No "exports" main defined in /p/node_modules/nodot/package.json imported from ${CONFIG}`,
          undefined,
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
        ),
      );
      expect(found).toEqual({
        kind: "package-subpath",
        package: "nodot",
        shown: "nodot",
        installHelps: false,
        remedy: NO_ENTRY,
      });
    });

    test("Node: the same sentence with no code is still recognized, and a scoped package is named whole", () => {
      const found = unresolvedImport({
        message: 'No "exports" main defined in /p/node_modules/@pithy-sh/core/package.json',
      });
      expect(found?.kind).toBe("package-subpath");
      expect(found?.package).toBe("@pithy-sh/core");
      expect(found?.shown).toBe("@pithy-sh/core");
    });

    test("Node: a main naming a missing file is the bare name, not the file", () => {
      const found = unresolvedImport(
        node(`Cannot find package '/p/node_modules/nodot/missing.js' imported from ${CONFIG}`),
        { relativeTo: ROOT },
      );
      expect(found).toEqual({
        kind: "package-subpath",
        package: "nodot",
        shown: "nodot",
        installHelps: false,
        remedy: NO_ENTRY,
      });
    });

    test("a dependency importing it by its bare name names both, and never an install", () => {
      const referrer = "/p/node_modules/deppkg/index.js";
      const found = unresolvedImport(bun("nodot", "Cannot find package 'nodot'", referrer), {
        installed: has("nodot"),
      });
      expect(found?.owner).toBe("deppkg");
      expect(found?.remedy).toBe(
        'deppkg imports "nodot", which the installed nodot does not provide. Bring deppkg and nodot to matching versions, or report this to its maintainer — installing dependencies will not help.',
      );
    });
  });

  describe("a deep import nothing can decide", () => {
    test("with no probe, or no referrer to probe from, both remedies and neither asserted", () => {
      const noProbe = unresolvedImport(bun("fakepkg/src/nope", "Cannot find package 'fakepkg'"));
      const noReferrer = unresolvedImport(
        { name: "ResolveMessage", message: "Cannot find package 'fakepkg'", specifier: "fakepkg/src/nope" },
        { installed: has("fakepkg") },
      );
      for (const found of [noProbe, noReferrer]) {
        expect(found?.kind).toBe("undetermined");
        expect(found?.package).toBe("fakepkg");
        expect(found?.remedy).toBe(
          'Nothing resolves "fakepkg/src/nope". Install the project\'s dependencies (bun install), or correct that import.',
        );
      }
    });
  });

  describe("a builtin the runtime does not provide", () => {
    // Bun 1.4.2 carries `node:nope` as written, with ERR_UNKNOWN_BUILTIN_MODULE and the referrer. Node 22
    // says the same code and sentence and nothing else, so it cannot say who imported it.
    test("is the runtime's, never a package, and never an install — on Bun and on Node", () => {
      const fromBun = unresolvedImport(
        bun("node:fs/promsies", "No such built-in module: node:fs/promsies", CONFIG, "ERR_UNKNOWN_BUILTIN_MODULE"),
      );
      const fromNode = unresolvedImport(
        node("No such built-in module: node:fs/promsies", undefined, "ERR_UNKNOWN_BUILTIN_MODULE"),
      );
      for (const found of [fromBun, fromNode]) {
        expect(found?.kind).toBe("builtin");
        expect(found?.package).toBeUndefined();
        expect(found?.installHelps).toBe(false);
        expect(found?.remedy).toBe(
          '"node:fs/promsies" is not a module this runtime provides. Correct that import — installing dependencies will not help.',
        );
      }
    });

    test("a dependency's builtin import names that dependency, never the package being loaded", () => {
      const referrer = "/p/node_modules/builtinpkg/index.js";
      const found = unresolvedImport(
        bun("node:nope", "No such built-in module: node:nope", referrer, "ERR_UNKNOWN_BUILTIN_MODULE"),
      );
      expect(found?.owner).toBe("builtinpkg");
      expect(found?.remedy).toBe(
        'builtinpkg imports "node:nope", which this runtime does not provide. Run it on a runtime that has that module, or report this to its maintainer — installing dependencies will not help.',
      );
    });

    // Node 22 refuses a scheme it has no loader for before it resolves anything. `bun:` is the one a kit
    // package could plausibly reach for.
    test("Node's unsupported scheme is the same kind, named by its scheme", () => {
      const found = unresolvedImport(
        node(
          "Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'bun:'",
          undefined,
          "ERR_UNSUPPORTED_ESM_URL_SCHEME",
        ),
      );
      expect(found?.kind).toBe("builtin");
      expect(found?.shown).toBe("bun:");
      expect(found?.installHelps).toBe(false);
    });

    test("a builtin-shaped specifier is never read as a package by its name", () => {
      const found = unresolvedImport(bun("node:nope", "Cannot find package 'node:nope'"), { installed: has() });
      expect(found?.kind).toBe("builtin");
    });
  });

  describe("the adopter's own missing file", () => {
    test("Bun's written specifier and Node's resolved path read the same, relative to the project", () => {
      const fromBun = unresolvedImport(bun("./src/x.js", "Cannot find module './src/x.js'"), {
        relativeTo: "/p/apps/api",
      });
      const fromNode = unresolvedImport(
        node(`Cannot find module '/p/apps/api/src/x.js' imported from ${CONFIG}`, "file:///p/apps/api/src/x.js"),
        { relativeTo: "/p/apps/api" },
      );
      for (const found of [fromBun, fromNode]) {
        expect(found?.kind).toBe("local-file");
        expect(found?.shown).toBe("./src/x.js");
        expect(found?.owner).toBeUndefined();
        expect(found?.remedy).toBe(
          'Nothing at "./src/x.js". Create that file or correct the import — installing dependencies will not help.',
        );
      }
    });

    // The finding that reached no gate: `readable()` handed a `file:///…` specifier straight to `action`.
    test("a file URL is a path, shown relative to the project, never as a URL", () => {
      const found = unresolvedImport(bun("file:///p/apps/api/src/y.js", "Cannot find module"), {
        relativeTo: "/p/apps/api",
      });
      expect(found?.kind).toBe("local-file");
      expect(found?.shown).toBe("./src/y.js");
      // Bun 1.4.2 converts it before it reaches the field. Read the same either way.
      const converted = unresolvedImport(bun("/p/apps/api/src/y.js", "Cannot find module"), {
        relativeTo: "/p/apps/api",
      });
      expect(converted?.remedy).toBe(found?.remedy);
    });

    test("a path outside the project, or with no project to relate it to, is never shown", () => {
      for (const found of [
        unresolvedImport(bun("file:///elsewhere/y.js", "Cannot find module"), { relativeTo: "/p" }),
        unresolvedImport(bun("/elsewhere/y.js", "Cannot find module")),
        unresolvedImport(node("Cannot find module '/p/src/x.js' imported from /p/a.js", "file:///p/src/x.js")),
        unresolvedImport(bun("C:\\p\\src\\x.ts", "Cannot find module")),
      ]) {
        expect(found?.kind).toBe("local-file");
        expect(found?.shown).toBeUndefined();
        expect(found?.remedy).toBe(
          "An import names a file that is not there. Create that file or correct the import — installing dependencies will not help.",
        );
      }
    });

    test("a file URL that will not decode is still a path, and still never shown", () => {
      const found = unresolvedImport(bun("file:///elsewhere/%E0.ts", "Cannot find module"), { relativeTo: "/p" });
      expect(found?.kind).toBe("local-file");
      expect(found?.remedy).not.toContain("file:");
    });

    test("a directory import is the adopter's import to correct", () => {
      const found = unresolvedImport(
        node(
          `Directory import '/p/apps/api/src' is not supported resolving ES modules imported from ${CONFIG}`,
          "file:///p/apps/api/src",
          "ERR_UNSUPPORTED_DIR_IMPORT",
        ),
        { relativeTo: "/p/apps/api" },
      );
      expect(found?.kind).toBe("local-file");
      expect(found?.shown).toBe("./src");
    });
  });

  describe("a # import", () => {
    test("the adopter's own: their imports map, read the same on Bun and on Node", () => {
      const fromBun = unresolvedImport(bun("#internal", "Cannot find package '#internal'"), { installed: has() });
      const fromNode = unresolvedImport(
        node(
          `Package import specifier "#internal" is not defined in package /p/apps/api/package.json imported from ${CONFIG}`,
          undefined,
          "ERR_PACKAGE_IMPORT_NOT_DEFINED",
        ),
      );
      for (const found of [fromBun, fromNode]) {
        expect(found?.kind).toBe("imports-map");
        expect(found?.package).toBeUndefined();
        expect(found?.remedy).toBe(
          '"#internal" is not in the project\'s imports map. Add it to the imports field of package.json, or correct the import — installing dependencies will not help.',
        );
      }
    });

    test("a package's own: its maintainer's to fix", () => {
      const referrer = "/p/node_modules/hashpkg/index.js";
      const found = unresolvedImport(bun("#internal/x", "Cannot find package '#internal'", referrer));
      expect(found?.owner).toBe("hashpkg");
      expect(found?.remedy).toBe(
        'hashpkg imports "#internal/x", which its own imports map does not provide. Report this to its maintainer — installing dependencies will not help.',
      );
    });
  });

  describe("a relative import that fails inside node_modules", () => {
    // Bun names the package's own file as referrer and the import as written; Node names the resolved path.
    test("is that package's missing file, read the same on Bun and on Node", () => {
      const referrer = "/p/node_modules/relpkg/index.js";
      const fromBun = unresolvedImport(bun("./missing.js", "Cannot find module './missing.js'", referrer));
      const fromNode = unresolvedImport(
        node(
          `Cannot find module '/p/node_modules/relpkg/missing.js' imported from ${referrer}`,
          "file:///p/node_modules/relpkg/missing.js",
        ),
      );
      for (const found of [fromBun, fromNode]) {
        expect(found?.kind).toBe("package-file");
        expect(found?.package).toBe("relpkg");
        expect(found?.owner).toBe("relpkg");
        expect(found?.shown).toBe("relpkg/missing.js");
        expect(found?.remedy).toBe(
          'relpkg is missing its own file "relpkg/missing.js". Report this to its maintainer — installing dependencies will not help.',
        );
      }
    });

    test("a store layout's nesting is walked to the real package, and `..` is followed", () => {
      const referrer = "/p/node_modules/.bun/@sc+pk@1.0.0/node_modules/@sc/pk/src/i.js";
      const found = unresolvedImport(bun("../lib/x.js", "Cannot find module '../lib/x.js'", referrer));
      expect(found?.package).toBe("@sc/pk");
      expect(found?.shown).toBe("@sc/pk/lib/x.js");
    });

    // Vite 8.3.0's module runner, measured: a relative file is its own `ERR_LOAD_URL` sentence.
    test("Vite's module runner says it in its own sentence, and is read the same", () => {
      const found = unresolvedImport({
        name: "Error",
        code: "ERR_LOAD_URL",
        message:
          "Failed to load url ./missing.js (resolved id: ./missing.js) in /p/node_modules/relpkg/index.js. Does the file exist?",
      });
      expect(found?.kind).toBe("package-file");
      expect(found?.shown).toBe("relpkg/missing.js");
    });
  });

  describe("Vite's module runner", () => {
    /** Vite 8.3.0's `runnerImport`, measured under Node and Bun alike: the specifier as written, the importer quoted. */
    const vite = (specifier: string, importer = CONFIG) => ({
      name: "Error",
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find module '${specifier}' imported from '${importer}'`,
    });

    test("the adopter's missing relative file is its own sentence, and reads as Bun's and Node's do", () => {
      const found = unresolvedImport(
        {
          name: "Error",
          code: "ERR_LOAD_URL",
          message: `Failed to load url ./src/x.js (resolved id: ./src/x.js) in ${CONFIG}. Does the file exist?`,
        },
        { relativeTo: "/p/apps/api" },
      );
      expect(found?.kind).toBe("local-file");
      expect(found?.remedy).toBe(
        unresolvedImport(bun("./src/x.js", "Cannot find module"), { relativeTo: "/p/apps/api" })?.remedy,
      );
      // Either quote, as the loaders write them.
      expect(unresolvedImport({ message: `Cannot find module "./src/x.js" imported from ${CONFIG}` })?.shown).toBe(
        "./src/x.js",
      );
    });

    test("a bare name with a path is asked of the probe, from the importer it quoted", () => {
      expect(unresolvedImport(vite("fakepkg/src/nope"), { installed: has("fakepkg") })?.kind).toBe("package-subpath");
      expect(unresolvedImport(vite("absentpkg/src/x"), { installed: has("fakepkg") })?.kind).toBe("package");
      expect(unresolvedImport(vite("@pithy-sh/auth"))?.kind).toBe("package");
    });
  });

  describe("the owner is never the loader", () => {
    // `pithy` itself does the importing for a capability, so a referrer inside `@pithy-sh/cli` is the
    // loader's frame. Naming it would send an adopter to the one package that is not at fault.
    test("a referrer inside the loader's own package is nobody's import", () => {
      const referrer = "/p/node_modules/@pithy-sh/cli/dist/project/kitResolve.js";
      const cause = bun("@pithy-sh/media/src/capability", "Cannot find package '@pithy-sh/media'", referrer);
      const named = unresolvedImport(cause, { installed: has("@pithy-sh/media") });
      const loaded = unresolvedImport(cause, { installed: has("@pithy-sh/media"), loader: "@pithy-sh/cli" });
      expect(named?.owner).toBe("@pithy-sh/cli");
      expect(loaded?.owner).toBeUndefined();
      expect(loaded?.remedy).not.toContain("@pithy-sh/cli");
    });
  });

  describe("an import with nothing to name", () => {
    test("hedges: both remedies, neither asserted", () => {
      const found = unresolvedImport({ message: "Failed to resolve module" });
      expect(found?.kind).toBe("unnamed");
      expect(found?.installHelps).toBe(true);
      expect(found?.remedy).toBe(
        "An import does not resolve. Check the imports, then install the project's dependencies (bun install).",
      );
    });
  });

  describe("no rendered field carries a path or a URL", () => {
    // Every remedy above, from every shape, under every option. A remedy is rendered; the path is not ours to show.
    test("whatever the shape, the remedy holds no absolute path and no file: URL", () => {
      const referrer = "/p/node_modules/x/index.js";
      const causes = [
        bun("file:///home/jo/app/y.js", "Cannot find module"),
        bun("/home/jo/app/y.js", "Cannot find module"),
        bun("./y.js", "Cannot find module", "/home/jo/app/a.js"),
        bun("./y.js", "Cannot find module", referrer),
        node("Cannot find module '/home/jo/app/y.js' imported from /home/jo/app/a.js", "file:///home/jo/app/y.js"),
        node(
          "Directory import '/home/jo/app/src' is not supported resolving ES modules imported from /home/jo/a.js",
          undefined,
          "ERR_UNSUPPORTED_DIR_IMPORT",
        ),
        { code: "MODULE_NOT_FOUND", message: "Cannot find module '/home/jo/app/y.js'" },
        {
          code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
          message: "Package subpath './x' is not defined by \"exports\" in /home/jo/node_modules/pkg/package.json",
        },
      ];
      for (const cause of causes) {
        for (const options of [{}, { relativeTo: "/elsewhere" }, { relativeTo: "/home/jo/app" }]) {
          const remedy = unresolvedImport(cause, options)?.remedy ?? "";
          expect(remedy, cause.message).not.toMatch(/(^|[\s"'(])\/(home|p)\b/);
          expect(remedy, cause.message).not.toContain("file:");
          expect(remedy, cause.message).not.toContain("node_modules");
        }
      }
    });
  });
});

describe("nodeModulesProbe", () => {
  /** A file system that holds exactly these `package.json` files, and resolves these links. */
  function tree(files: string[], links: Record<string, string> = {}) {
    return {
      exists: (path: string) => files.includes(path.replaceAll("\\", "/")),
      realpath: (path: string) => links[path] ?? path,
    };
  }

  test("walks node_modules up from the importing file's directory", () => {
    const probe = nodeModulesProbe(tree(["/p/node_modules/@pithy-sh/core/package.json"]));
    expect(probe("@pithy-sh/core", "/p/apps/api/x.ts")).toBe(true);
    expect(probe("@pithy-sh/absent", "/p/apps/api/x.ts")).toBe(false);
  });

  // A package directory with no manifest is a half-written install, not an installed package.
  test("a directory with no package.json is not installed", () => {
    const probe = nodeModulesProbe(tree([]));
    expect(probe("@pithy-sh/hollow", "/p/apps/api/x.ts")).toBe(false);
  });

  // The finding that reached no gate. Bun's isolated linker puts a package behind a symlink, and the
  // resolver walked from where the link points. Walked from the link, a copy that is not the one the
  // resolver used answers for it.
  test("walks from where a symlinked importer really is, the chain the resolver used", () => {
    // Bun's isolated linker: the root links only its direct dependencies, and each package's own
    // dependencies sit beside its real directory in the store. `core` is email's, so it is only there.
    const linked = "/p/node_modules/@pithy-sh/email/src/capability.js";
    const real = "/p/node_modules/.bun/@pithy-sh+email@1.0.0/node_modules/@pithy-sh/email/src/capability.js";
    const files = [
      "/p/node_modules/.bun/@pithy-sh+email@1.0.0/node_modules/@pithy-sh/email/package.json",
      "/p/node_modules/.bun/@pithy-sh+email@1.0.0/node_modules/@pithy-sh/core/package.json",
    ];
    const probe = nodeModulesProbe(tree(files, { [linked]: real }));
    expect(probe("@pithy-sh/core", linked)).toBe(true);
    // Walked from the link as given, the same tree says it is absent, and the adopter is told to install.
    const asGiven = nodeModulesProbe({ exists: tree(files).exists, realpath: (path) => path });
    expect(asGiven("@pithy-sh/core", linked)).toBe(false);
  });

  test("an importer that cannot be resolved is walked as given", () => {
    const probe = nodeModulesProbe({
      exists: (path) => path === "/p/node_modules/x/package.json",
      realpath: () => {
        throw new Error("ENOENT");
      },
    });
    expect(probe("x", "/p/apps/api/gone.ts")).toBe(true);
  });

  test("stops at the root, POSIX or Windows", () => {
    const probe = nodeModulesProbe({ exists: () => false, realpath: (path) => path });
    expect(probe("x", "/a.ts")).toBe(false);
    expect(probe("x", "C:\\p\\a.ts")).toBe(false);
    const windows = nodeModulesProbe({
      exists: (path) => path === "C:\\p/node_modules/x/package.json",
      realpath: (path) => path,
    });
    expect(windows("x", "C:\\p\\apps\\a.ts")).toBe(true);
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
