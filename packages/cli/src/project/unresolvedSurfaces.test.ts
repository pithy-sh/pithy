// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { classifyWorkerConfigFailure } from "@pithy-sh/vite/src/workerConfig";
import { afterAll, describe, expect, test } from "vitest";
import { classifyCapabilityLoadFailure } from "../capabilities/loadFailure";
import { sourceFiles } from "../ci/sourceFiles";
import { classifyConfigLoadFailure } from "./config";

/**
 * **One unresolved import, three surfaces, one remedy (#709).**
 *
 * The CLI's config loader, its capability loaders and the vite plugin each refuse a module that will not
 * resolve. Each used to keep its own rules for the parts core did not decide, and three review rounds each
 * found one of them giving advice the other two had stopped giving. The rules are core's now
 * (`@pithy-sh/core/src/error/unresolved`), and this file is what keeps them there: every kind, in the
 * shape each runtime really throws it, through all three surfaces, and the same sentence out of each.
 *
 * **The shapes are measured, and measured again on every run.** {@link SHAPES} is what Bun 1.4.2 and Node
 * 22.23.3 threw importing the tree {@link stage} builds (Node 24.21.0 throws the same). The last describe
 * spawns both runtimes against that tree and asserts they still throw exactly that, so a runtime that
 * changes a shape fails here rather than quietly changing a remedy. `noDot` and `mainMissing` were added after
 * review and measured on Bun 1.4.2 and Node 24.21.0; CI's Node 22 floor job re-checks them there.
 *
 * Staged in the OS temp directory: a tree under this repository walks up into the workspace's own
 * `node_modules`, where every package is installed, and the probe would find them.
 */

/** The imports, one per case file, written as an adopter or a package would write them. */
const IMPORTS = {
  absent: "absentpkg",
  absentDeep: "absentpkg/src/x",
  subpath: "fakepkg/src/nope",
  scopedSubpath: "@sc/pk/src/nope",
  unexported: "expkg/hidden.js",
  noDot: "nodot",
  mainMissing: "nomain",
  builtin: "node:nope",
  builtinSubpath: "node:fs/promsies",
  bunScheme: "bun:nope",
  local: "./src/x.js",
  directory: "./src",
  fileUrl: "file://<root>/src/y.js",
  hash: "#internal",
  hashInPackage: "hashpkg",
  relativeInPackage: "relpkg",
  dependencyAbsent: "deppkg",
  dependencyBuiltin: "builtinpkg",
} as const;

type Case = keyof typeof IMPORTS;

/** The tree every shape was measured against. `<root>` is the directory it is staged in. */
const TREE: Record<string, string> = {
  "package.json": '{"name":"proj","type":"module"}',
  "src/.keep": "",
  "node_modules/fakepkg/package.json": '{"name":"fakepkg","type":"module","main":"index.js"}',
  "node_modules/fakepkg/index.js": "export default 1;",
  "node_modules/@sc/pk/package.json": '{"name":"@sc/pk","type":"module","main":"index.js"}',
  "node_modules/@sc/pk/index.js": "export default 1;",
  "node_modules/expkg/package.json": '{"name":"expkg","type":"module","exports":{".":"./index.js"}}',
  "node_modules/expkg/index.js": "export default 1;",
  "node_modules/expkg/hidden.js": "export default 1;",
  "node_modules/nodot/package.json": '{"name":"nodot","type":"module","exports":{"./x.js":"./x.js"}}',
  "node_modules/nodot/x.js": "export default 1;",
  "node_modules/nomain/package.json": '{"name":"nomain","type":"module","main":"missing.js"}',
  "node_modules/relpkg/package.json": '{"name":"relpkg","type":"module","main":"index.js"}',
  "node_modules/relpkg/index.js": 'import "./missing.js";',
  "node_modules/hashpkg/package.json":
    '{"name":"hashpkg","type":"module","main":"index.js","imports":{"#other":"./index.js"}}',
  "node_modules/hashpkg/index.js": 'import "#internal";',
  "node_modules/deppkg/package.json": '{"name":"deppkg","type":"module","main":"index.js"}',
  "node_modules/deppkg/index.js": 'import "absentdep/src/x";',
  "node_modules/builtinpkg/package.json": '{"name":"builtinpkg","type":"module","main":"index.js"}',
  "node_modules/builtinpkg/index.js": 'import "node:nope";',
};

/** The fields a classifier reads, as the runtime set them. `<root>` stands for the staged directory. */
interface Shape {
  name: string;
  code: string;
  message: string;
  specifier?: string;
  referrer?: string;
  url?: string;
}

/**
 * A Bun 1.4.2 `ResolveMessage`. Every case carries the import as written and the file it is in; the
 * sentence names that file too, except for a missing builtin, whose sentence stops at the specifier.
 */
function bun(code: string, sentence: string, specifier: string, referrer: string): Shape {
  const message = code === BUILTIN ? sentence : `${sentence} imported from ${referrer}`;
  return { name: "ResolveMessage", code, message, specifier, referrer };
}

/** Node 22's error: a code, a sentence, and the resolved `url` for a module it found the path of. */
function node(name: string, code: string, message: string, url?: string): Shape {
  return url === undefined ? { name, code, message } : { name, code, message, url };
}

const NF = "ERR_MODULE_NOT_FOUND";
const BUILTIN = "ERR_UNKNOWN_BUILTIN_MODULE";
const R = "<root>";

/** What each runtime threw, verbatim but for the staged directory. */
const SHAPES: Record<Case, { bun: Shape; node: Shape }> = {
  absent: {
    bun: bun(NF, "Cannot find package 'absentpkg'", "absentpkg", `${R}/case-absent.js`),
    node: node("Error", NF, `Cannot find package 'absentpkg' imported from ${R}/case-absent.js`),
  },
  absentDeep: {
    bun: bun(NF, "Cannot find package 'absentpkg'", "absentpkg/src/x", `${R}/case-absentDeep.js`),
    node: node("Error", NF, `Cannot find package 'absentpkg' imported from ${R}/case-absentDeep.js`),
  },
  subpath: {
    bun: bun(NF, "Cannot find package 'fakepkg'", "fakepkg/src/nope", `${R}/case-subpath.js`),
    node: node(
      "Error",
      NF,
      `Cannot find module '${R}/node_modules/fakepkg/src/nope' imported from ${R}/case-subpath.js`,
      `file://${R}/node_modules/fakepkg/src/nope`,
    ),
  },
  scopedSubpath: {
    bun: bun(NF, "Cannot find package '@sc/pk'", "@sc/pk/src/nope", `${R}/case-scopedSubpath.js`),
    node: node(
      "Error",
      NF,
      `Cannot find module '${R}/node_modules/@sc/pk/src/nope' imported from ${R}/case-scopedSubpath.js`,
      `file://${R}/node_modules/@sc/pk/src/nope`,
    ),
  },
  unexported: {
    bun: bun(NF, "Cannot find package 'expkg'", "expkg/hidden.js", `${R}/case-unexported.js`),
    node: node(
      "Error",
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      `Package subpath './hidden.js' is not defined by "exports" in ${R}/node_modules/expkg/package.json imported from ${R}/case-unexported.js`,
    ),
  },
  noDot: {
    // Bun 1.4.2 says of an installed package with no "." export what it says of an absent one.
    bun: bun(NF, "Cannot find package 'nodot'", "nodot", `${R}/case-noDot.js`),
    node: node(
      "Error",
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      `No "exports" main defined in ${R}/node_modules/nodot/package.json imported from ${R}/case-noDot.js`,
    ),
  },
  mainMissing: {
    bun: bun(NF, "Cannot find package 'nomain'", "nomain", `${R}/case-mainMissing.js`),
    // Node names the package by the path its `main` points to, and sets no `url`.
    node: node(
      "Error",
      NF,
      `Cannot find package '${R}/node_modules/nomain/missing.js' imported from ${R}/case-mainMissing.js`,
    ),
  },
  builtin: {
    bun: bun(BUILTIN, "No such built-in module: node:nope", "node:nope", `${R}/case-builtin.js`),
    node: node("Error", BUILTIN, "No such built-in module: node:nope"),
  },
  builtinSubpath: {
    bun: bun(BUILTIN, "No such built-in module: node:fs/promsies", "node:fs/promsies", `${R}/case-builtinSubpath.js`),
    node: node("Error", BUILTIN, "No such built-in module: node:fs/promsies"),
  },
  bunScheme: {
    // Bun 1.4.2 drops the scheme: what it reports is a package called `nope`.
    bun: bun(NF, "Cannot find package 'nope'", "nope", `${R}/case-bunScheme.js`),
    node: node(
      "Error",
      "ERR_UNSUPPORTED_ESM_URL_SCHEME",
      "Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'bun:'",
    ),
  },
  local: {
    bun: bun(NF, "Cannot find module './src/x.js'", "./src/x.js", `${R}/case-local.js`),
    node: node(
      "Error",
      NF,
      `Cannot find module '${R}/src/x.js' imported from ${R}/case-local.js`,
      `file://${R}/src/x.js`,
    ),
  },
  directory: {
    bun: bun(NF, "Cannot find module './src'", "./src", `${R}/case-directory.js`),
    node: node(
      "Error",
      "ERR_UNSUPPORTED_DIR_IMPORT",
      `Directory import '${R}/src' is not supported resolving ES modules imported from ${R}/case-directory.js`,
      `file://${R}/src`,
    ),
  },
  fileUrl: {
    // Bun 1.4.2 converts the URL to a path before it reaches the field.
    bun: bun(NF, `Cannot find module '${R}/src/y.js'`, `${R}/src/y.js`, `${R}/case-fileUrl.js`),
    node: node(
      "Error",
      NF,
      `Cannot find module '${R}/src/y.js' imported from ${R}/case-fileUrl.js`,
      `file://${R}/src/y.js`,
    ),
  },
  hash: {
    bun: bun(NF, "Cannot find package '#internal'", "#internal", `${R}/case-hash.js`),
    node: node(
      "TypeError",
      "ERR_PACKAGE_IMPORT_NOT_DEFINED",
      `Package import specifier "#internal" is not defined in package ${R}/package.json imported from ${R}/case-hash.js`,
    ),
  },
  hashInPackage: {
    bun: bun(NF, "Cannot find package '#internal'", "#internal", `${R}/node_modules/hashpkg/index.js`),
    node: node(
      "TypeError",
      "ERR_PACKAGE_IMPORT_NOT_DEFINED",
      `Package import specifier "#internal" is not defined in package ${R}/node_modules/hashpkg/package.json imported from ${R}/node_modules/hashpkg/index.js`,
    ),
  },
  relativeInPackage: {
    bun: bun(NF, "Cannot find module './missing.js'", "./missing.js", `${R}/node_modules/relpkg/index.js`),
    node: node(
      "Error",
      NF,
      `Cannot find module '${R}/node_modules/relpkg/missing.js' imported from ${R}/node_modules/relpkg/index.js`,
      `file://${R}/node_modules/relpkg/missing.js`,
    ),
  },
  dependencyAbsent: {
    bun: bun(NF, "Cannot find package 'absentdep'", "absentdep/src/x", `${R}/node_modules/deppkg/index.js`),
    node: node("Error", NF, `Cannot find package 'absentdep' imported from ${R}/node_modules/deppkg/index.js`),
  },
  dependencyBuiltin: {
    bun: bun(BUILTIN, "No such built-in module: node:nope", "node:nope", `${R}/node_modules/builtinpkg/index.js`),
    node: node("Error", BUILTIN, "No such built-in module: node:nope"),
  },
};

const INSTALL = "Install the project's dependencies (bun install)";
const NO_INSTALL = "installing dependencies will not help.";

/**
 * The remedy for each case — one sentence for both runtimes, except where one of them says less.
 *
 * Two do. Node 22 names no importer for a missing builtin, so a dependency's `node:nope` cannot be laid at
 * the dependency's door on Node, and Bun 1.4.2 reports `bun:nope` as a package called `nope`, so on Bun it
 * cannot be told from an absent package. Each is the runtime withholding the fact, and each is pinned here
 * so that a runtime that starts handing it over shows up as a failure to update, not a silent change.
 */
const REMEDIES: Record<Case, string | { bun: string; node: string }> = {
  absent: `"absentpkg" is not installed. ${INSTALL}, or correct that import.`,
  absentDeep: `"absentpkg" is not installed. ${INSTALL}, or correct that import.`,
  subpath: `"fakepkg/src/nope" is not something the installed fakepkg provides. Check the version of fakepkg you have, or correct that import — ${NO_INSTALL}`,
  scopedSubpath: `"@sc/pk/src/nope" is not something the installed @sc/pk provides. Check the version of @sc/pk you have, or correct that import — ${NO_INSTALL}`,
  unexported: `"expkg/hidden.js" is not something the installed expkg provides. Check the version of expkg you have, or correct that import — ${NO_INSTALL}`,
  noDot: `The installed nodot has no entry to import by its bare name. Import one of its paths, or check the version of nodot you have — ${NO_INSTALL}`,
  mainMissing: `The installed nomain has no entry to import by its bare name. Import one of its paths, or check the version of nomain you have — ${NO_INSTALL}`,
  builtin: `"node:nope" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
  builtinSubpath: `"node:fs/promsies" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
  bunScheme: {
    bun: `"nope" is not installed. ${INSTALL}, or correct that import.`,
    node: `"bun:" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
  },
  local: `Nothing at "./src/x.js". Create that file or correct the import — ${NO_INSTALL}`,
  directory: `Nothing at "./src". Create that file or correct the import — ${NO_INSTALL}`,
  fileUrl: `Nothing at "./src/y.js". Create that file or correct the import — ${NO_INSTALL}`,
  hash: `"#internal" is not in the project's imports map. Add it to the imports field of package.json, or correct the import — ${NO_INSTALL}`,
  hashInPackage: `hashpkg imports "#internal", which its own imports map does not provide. Report this to its maintainer — ${NO_INSTALL}`,
  relativeInPackage: `relpkg is missing its own file "relpkg/missing.js". Report this to its maintainer — ${NO_INSTALL}`,
  dependencyAbsent: `deppkg imports "absentdep", which is not installed. ${INSTALL}. If it is still missing, deppkg does not declare it — report that to its maintainer.`,
  dependencyBuiltin: {
    bun: `builtinpkg imports "node:nope", which this runtime does not provide. Run it on a runtime that has that module, or report this to its maintainer — ${NO_INSTALL}`,
    node: `"node:nope" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
  },
};

/** Stage {@link TREE} and one case file per import in a fresh directory, and return its real path. */
function stage(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-unresolved-")));
  for (const [path, text] of Object.entries(TREE)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const [name, specifier] of Object.entries(IMPORTS)) {
    writeFileSync(join(root, `case-${name}.js`), `import ${JSON.stringify(specifier.replace(R, root))};\n`);
  }
  return root;
}

/** A recorded shape, with the staged directory put back where it was measured. */
function placed(shape: Shape, root: string): Shape {
  return JSON.parse(JSON.stringify(shape).replaceAll(R, root)) as Shape;
}

const root = stage();
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** All three surfaces, each told the same project. The capability loader is loading something else. */
function surfaces(cause: unknown): Record<string, { kind: string; action: string }> {
  return {
    "pithy.config.ts (CLI)": classifyConfigLoadFailure(cause, root),
    "a capability loader (CLI)": classifyCapabilityLoadFailure(
      "payments",
      "@pithy-sh/payments/src/capability",
      cause,
      root,
    ),
    "the vite plugin": classifyWorkerConfigFailure(cause, root),
  };
}

describe("every kind, in both runtimes' shapes, through all three surfaces", () => {
  for (const name of Object.keys(IMPORTS) as Case[]) {
    for (const runtime of ["bun", "node"] as const) {
      test(`${name}, as ${runtime === "bun" ? "Bun 1.4.2" : "Node 22"} throws it`, () => {
        const expected = REMEDIES[name];
        const remedy = typeof expected === "string" ? expected : expected[runtime];
        for (const [surface, { kind, action }] of Object.entries(surfaces(placed(SHAPES[name][runtime], root)))) {
          expect(action, surface).toBe(remedy);
          expect(kind, surface).not.toBe("unknown");
          // No rendered field carries a path or a URL, whatever the shape handed over.
          expect(action, surface).not.toContain(root);
          expect(action, surface).not.toContain("file:");
          expect(action, surface).not.toContain("node_modules");
        }
      });
    }
  }

  // The finding the last round never got to a gate: a remedy that says to install where installing cannot
  // help. Read off the table rather than asserted per row, so a new row cannot forget it.
  test("an install is named only where an install can help", () => {
    const installs = new Set<Case>(["absent", "absentDeep", "dependencyAbsent"]);
    for (const name of Object.keys(IMPORTS) as Case[]) {
      for (const runtime of ["bun", "node"] as const) {
        const expected = REMEDIES[name];
        const remedy = typeof expected === "string" ? expected : expected[runtime];
        // Bun 1.4.2's `bun:nope` is the one a runtime takes out of our hands: see REMEDIES.
        const says = installs.has(name) || (name === "bunScheme" && runtime === "bun");
        expect(remedy.includes("bun install"), `${name} on ${runtime}`).toBe(says);
        if (!says) expect(remedy, `${name} on ${runtime}`).toContain(NO_INSTALL);
      }
    }
  });
});

/**
 * **The shapes above are what the runtimes throw today**, not what they threw once.
 *
 * Both runtimes import every case file in the staged tree, in a child process, and hand back the fields
 * the classifier reads. They must match {@link SHAPES} exactly. Node is whichever Node runs this suite —
 * 24 here, 22 in CI's floor job — and the two throw the same, which this asserts on both. Bun is spawned
 * as `config.test.ts` spawns it: every CI job that runs this suite installs it.
 */
describe("the recorded shapes are still the shapes", () => {
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    [
      "const shapes = {};",
      "for (const name of process.argv.slice(2)) {",
      '  try { await import(new URL("./case-" + name + ".js", import.meta.url).href); shapes[name] = null; }',
      "  catch (thrown) {",
      "    const e = Array.isArray(thrown?.errors) && thrown.errors.length > 0 ? thrown.errors[0] : thrown;",
      "    const shape = {};",
      '    for (const field of ["name", "code", "message", "specifier", "referrer", "url"]) if (typeof e?.[field] === "string") shape[field] = e[field];',
      "    shapes[name] = shape;",
      "  }",
      "}",
      "console.log(JSON.stringify(shapes));",
    ].join("\n"),
  );

  /** What `command` threw for every case, with the staged directory put back to `<root>`. */
  async function measured(command: string, args: string[]): Promise<Record<string, Shape>> {
    const { stdout } = await promisify(execFile)(command, [...args, probe, ...Object.keys(IMPORTS)], { cwd: root });
    const href = pathToFileURL(root).href.replace(/^file:\/\//, "");
    return JSON.parse(stdout.replaceAll(href, R).replaceAll(root, R)) as Record<string, Shape>;
  }

  /** The recorded shapes for one runtime, keyed as the probe keys them. */
  function recorded(runtime: "bun" | "node"): Record<string, Shape> {
    return Object.fromEntries((Object.keys(IMPORTS) as Case[]).map((name) => [name, SHAPES[name][runtime]]));
  }

  test("Bun 1.4.2", { timeout: 30_000 }, async () => {
    expect(await measured("bun", [])).toEqual(recorded("bun"));
  });

  test("Node", { timeout: 30_000 }, async () => {
    expect(await measured(process.execPath, ["--no-deprecation"])).toEqual(recorded("node"));
  });
});

/**
 * **The gate: no surface keeps an import rule of its own.**
 *
 * The defect was never one wrong sentence. It was three places each deciding, so a fix to one was a
 * divergence from the other two. What this asks is the decidable question, in the spirit of the #228 gate
 * in `config.test.ts`: does a module outside core's classifier **recognize** an unresolved import — test
 * a cause for a resolver's code, Bun's `ResolveMessage`, or a resolver's sentence? Every one of the three
 * copies this replaced did, and a fourth would have to.
 *
 * It does not flag a module that *throws* one. `kitResolve.ts` builds `MODULE_NOT_FOUND` with Node's own
 * sentence so the classifier reads its refusal like any other, and that is producing a cause, not
 * classifying one.
 */
describe("the gate: one classifier", () => {
  /** `packages/cli/src/project` → the repository. */
  const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

  /** The one module allowed to recognize an unresolved import. */
  const CLASSIFIER = "packages/core/src/error/unresolved.ts";

  /** The codes only a resolver throws. `MODULE_NOT_FOUND` is left out: a module may build one to throw it. */
  const CODES = [
    "ERR_MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "ERR_PACKAGE_IMPORT_NOT_DEFINED",
    "ERR_UNSUPPORTED_DIR_IMPORT",
    "ERR_UNKNOWN_BUILTIN_MODULE",
    "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  ];

  /** How `source` recognizes an unresolved import on its own, or null. Comments do not count. */
  function recognizesUnresolved(source: string): string | null {
    const code = blankComments(source);
    const found: string[] = [];
    for (const name of CODES) if (code.includes(`"${name}"`)) found.push(name);
    if (code.includes('"ResolveMessage"')) found.push("ResolveMessage");
    if (code.includes("Cannot find (")) found.push("a resolver's sentence");
    if (code.includes('is not defined by "exports"/')) found.push("an exports-map sentence");
    return found.length === 0 ? null : found.join(", ");
  }

  test("scans the repository, and finds the classifier", () => {
    const files = sourceFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(500);
    const classifier = files.find((file) => relative(REPO_ROOT, file.path).split(sep).join("/") === CLASSIFIER);
    expect(classifier).toBeDefined();
    // Not vacuous: the classifier itself reads as one, so a rename past this rule turns it red.
    expect(recognizesUnresolved(classifier?.text ?? "")).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  test("only core's classifier recognizes an unresolved import", () => {
    const recognizers = new Map<string, string>();
    for (const file of sourceFiles(REPO_ROOT)) {
      const how = recognizesUnresolved(file.text);
      if (how !== null) recognizers.set(relative(REPO_ROOT, file.path).split(sep).join("/"), how);
    }
    expect(
      Object.fromEntries(recognizers),
      "call unresolvedImport from @pithy-sh/core/src/error/unresolved — do not write a second classifier",
    ).toEqual({ [CLASSIFIER]: expect.any(String) });
  });

  test("the gate bites: the copy each surface kept is named, wherever it is planted", () => {
    // Verbatim from `capabilities/loadFailure.ts` before this issue.
    const planted = [
      "function isUnresolvedImport(cause: unknown): boolean {",
      '  const code = prop(cause, "code");',
      '  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;',
      '  if (prop(cause, "name") === "ResolveMessage") return true;',
      "  return /Cannot find (?:package|module) |Failed to resolve (?:import|module)/.test(rawMessage(cause));",
      "}",
    ].join("\n");
    expect(recognizesUnresolved(planted)).toBe("ERR_MODULE_NOT_FOUND, ResolveMessage, a resolver's sentence");
    // Building a cause to throw is not recognizing one: `kitResolve.ts` does exactly this.
    expect(
      recognizesUnresolved(
        'return Object.assign(new Error("Cannot find package \'" + pkg + "\'"), { code: "MODULE_NOT_FOUND" });',
      ),
    ).toBeNull();
    // Nor is naming one in a comment.
    expect(recognizesUnresolved("// Bun throws ERR_MODULE_NOT_FOUND and a ResolveMessage here.\n")).toBeNull();
  });
});
