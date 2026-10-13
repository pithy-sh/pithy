// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { loadWorkerConfig } from "@pithy-sh/vite/src/workerConfig";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { classifyCapabilityLoadFailure } from "../capabilities/loadFailure";
import { sourceFiles } from "../ci/sourceFiles";
import { classifyConfigLoadFailure } from "./config";

/**
 * **One unresolved import, three surfaces, one remedy (#709).**
 *
 * The CLI's config loader, its capability loaders and the vite plugin each refuse a module that will not
 * resolve. Each used to keep its own rules for the parts core did not decide, and three review rounds each
 * found one of them giving advice the other two had stopped giving. The rules are core's now
 * (`@pithy-sh/core/src/error/unresolved`), and this file is what keeps them there.
 *
 * **Every cause here is thrown by the loader that surface really uses, on every run.** Nothing is
 * recorded. The second review round found the vite plugin blaming an adopter's config for `@pithy-sh/core`
 * and an unbuilt package told to "import one of its paths", both because this file once fed every surface
 * hand-recorded Bun and Node shapes — and the vite plugin never sees either. It loads through Vite's
 * `runnerImport`, which throws its own. So each case is staged on disk and imported for real:
 *
 * - **Bun** — a Bun child imports the case and hands what it threw, as thrown, to both CLI classifiers.
 *   That is what the shipped `bin` does: it runs on Bun, and its loaders are a plain `import()`.
 * - **Node** — a child of whichever Node runs this suite (24 here, 22 in CI's floor job) imports the case
 *   and hands back every string the error carries, which the two CLI classifiers then read. Vitest's own
 *   module runner sits between a test and a native `import()`, which is why it is a child.
 * - **Vite** — `loadWorkerConfig`, the plugin's real loader, in this process: `runnerImport`, its
 *   classifier, and the refusal it throws.
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
  conditionsOnly: "condonly",
  noEntry: "noentry",
  mainMissing: "nomain",
  mainDirectory: "maindir",
  exportsMissing: "exmiss",
  exportsSubpathMissing: "patpkg/src/capability",
  patternTypo: "patbuilt/src/capabilty",
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
  dependencyEntryMissing: "entrydep",
  typeModuleCommonjsCode: "cjsinesm",
  typeCommonjsModuleCode: "esmincjs",
} as const;

type Case = keyof typeof IMPORTS;
const CASES = Object.keys(IMPORTS) as Case[];

/**
 * The tree every case is imported from. `<root>` is the directory it is staged in.
 *
 * Every way an installed package's bare name can fail is here, because each runtime words them
 * differently and Bun words them all as an absent package: an `exports` map with no `"."`, one whose `"."`
 * matches no condition an ESM import uses, no `exports` and no `main` with no `index.js`, and three that
 * **declare** an entry whose file is missing — `main` to a file, `main` to a directory, and `exports` —
 * which is an unbuilt package or a broken install. A deep import is here twice through the `exports`
 * pattern every `@pithy-sh/*` package declares (`./src/*` → `./dist/*.js`): once with no `dist` at all,
 * which is that package unbuilt, and once with `dist` built and the import misspelled, which is not.
 *
 * And two packages whose `"type"` does not match their code: `module` over `module.exports`, and
 * `commonjs` over `import`. Neither is a resolution failure — Node throws a `ReferenceError` and a
 * `SyntaxError` from inside the package — but neither is the config's own throw or its own parse error.
 */
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
  "node_modules/condonly/package.json":
    '{"name":"condonly","type":"module","exports":{".":{"browser":"./b.js","require":"./c.cjs"}}}',
  "node_modules/condonly/b.js": "export default 1;",
  "node_modules/condonly/c.cjs": "module.exports = 1;",
  "node_modules/noentry/package.json": '{"name":"noentry","type":"module"}',
  "node_modules/nomain/package.json": '{"name":"nomain","type":"module","main":"missing.js"}',
  "node_modules/maindir/package.json": '{"name":"maindir","type":"module","main":"lib"}',
  "node_modules/maindir/lib/.keep": "",
  "node_modules/exmiss/package.json": '{"name":"exmiss","type":"module","exports":{".":"./dist/index.js"}}',
  "node_modules/relpkg/package.json": '{"name":"relpkg","type":"module","main":"index.js"}',
  "node_modules/relpkg/index.js": 'import "./missing.js";',
  "node_modules/hashpkg/package.json":
    '{"name":"hashpkg","type":"module","main":"index.js","imports":{"#other":"./index.js"}}',
  "node_modules/hashpkg/index.js": 'import "#internal";',
  "node_modules/deppkg/package.json": '{"name":"deppkg","type":"module","main":"index.js"}',
  "node_modules/deppkg/index.js": 'import "absentdep/src/x";',
  "node_modules/builtinpkg/package.json": '{"name":"builtinpkg","type":"module","main":"index.js"}',
  "node_modules/builtinpkg/index.js": 'import "node:nope";',
  "node_modules/entrydep/package.json": '{"name":"entrydep","type":"module","main":"index.js"}',
  "node_modules/entrydep/index.js": 'import "exmiss";',
  "node_modules/patpkg/package.json":
    '{"name":"patpkg","type":"module","exports":{"./src/*":{"types":"./dist/*.d.ts","default":"./dist/*.js"}}}',
  "node_modules/patpkg/src/capability.ts": "export default 1;",
  "node_modules/patbuilt/package.json":
    '{"name":"patbuilt","type":"module","exports":{"./src/*":{"types":"./dist/*.d.ts","default":"./dist/*.js"}}}',
  "node_modules/patbuilt/dist/capability.js": "export default 1;",
  "node_modules/cjsinesm/package.json": '{"name":"cjsinesm","type":"module","main":"index.js"}',
  "node_modules/cjsinesm/index.js": "module.exports = 1;",
  "node_modules/esmincjs/package.json": '{"name":"esmincjs","type":"commonjs","main":"index.js"}',
  "node_modules/esmincjs/index.js": 'import { sep } from "node:path";\nexport default sep;\n',
  "node_modules/badparse/package.json": '{"name":"badparse","type":"module","main":"index.js"}',
  "node_modules/badparse/index.js": "export const x = ;\n",
  "node_modules/fake5/package.json": '{"name":"fake5","type":"module","main":"index.js"}',
  "node_modules/fake5/index.js":
    "export function parse(text) {\n  throw new SyntaxError(\"JSON5: invalid character ',' at 1:2\");\n}\n",
};

/**
 * **Two loads that are not an import failing to resolve**, so they are not rows of {@link REMEDIES}: what a
 * surface says for them is not one sentence across the three. Each is a whole case file, not one import.
 *
 * - `packageParse` — an installed package whose own file does not parse. Bun 1.4.2 throws a `BuildMessage`
 *   with no stack, and names the file only in its `position`.
 * - `packageThrows` — the config calls a package's function with bad input, and the function throws a
 *   `SyntaxError` on purpose, as json5's `parse` does. The package loaded; the input is the adopter's.
 */
const LOADS = {
  packageParse: 'import "badparse";\n',
  packageThrows: 'import { parse } from "fake5";\nparse("{,}");\n',
} as const;

type Load = keyof typeof LOADS;
const LOAD_CASES = Object.keys(LOADS) as Load[];
/** Every case file each loader imports. */
const ALL_CASES: string[] = [...CASES, ...LOAD_CASES];

const INSTALL = "Install the project's dependencies (bun install)";
const NO_INSTALL = "installing dependencies will not help.";

/** An installed package with nothing to import by its bare name. */
const noEntry = (pkg: string) =>
  `The installed ${pkg} has no entry to import by its bare name. Import one of its paths, or check the version of ${pkg} you have — ${NO_INSTALL}`;

/** An installed package whose package.json names an entry that is not on disk. */
const entryMissing = (pkg: string) =>
  `The installed ${pkg} names an entry that is not there, so it is unbuilt or its install is broken. Rebuild ${pkg}, or remove it and install it again.`;

/** An installed package whose code and declared `"type"` disagree, named as the one that will not load. */
const typeMismatch = (pkg: string) =>
  `The installed ${pkg} does not load as the module type its package.json declares. Check the version of ${pkg} you have, or report this to its maintainer — ${NO_INSTALL}`;

/** Where a cause came from: the runtime and loader that threw it. */
type Source = "bun" | "node" | "vite";
const SOURCES: Source[] = ["bun", "node", "vite"];
const SOURCE_NAME: Record<Source, string> = {
  bun: "Bun's import()",
  node: "Node's import()",
  vite: "Vite's runnerImport",
};

/**
 * The remedy for each case — **one sentence, whichever runtime threw it and whichever surface read it**,
 * except where a runtime withholds the fact the sentence needs.
 *
 * Two do, and each is pinned here so a runtime that starts handing the fact over shows up as a row to
 * update, not a silent change. Node names no importer for a missing builtin, so a dependency's
 * `node:nope` cannot be laid at the dependency's door — and Vite hands a dependency's imports to Node, so
 * the plugin cannot either. Bun 1.4.2 reports `bun:nope` as a package called `nope`, so on Bun it cannot be
 * told from an absent package.
 */
const REMEDIES: Record<Case, string | ({ default: string } & Partial<Record<Source, string | null>>)> = {
  absent: `"absentpkg" is not installed. ${INSTALL}, or correct that import.`,
  absentDeep: `"absentpkg" is not installed. ${INSTALL}, or correct that import.`,
  subpath: `"fakepkg/src/nope" is not something the installed fakepkg provides. Check the version of fakepkg you have, or correct that import — ${NO_INSTALL}`,
  scopedSubpath: `"@sc/pk/src/nope" is not something the installed @sc/pk provides. Check the version of @sc/pk you have, or correct that import — ${NO_INSTALL}`,
  unexported: `"expkg/hidden.js" is not something the installed expkg provides. Check the version of expkg you have, or correct that import — ${NO_INSTALL}`,
  noDot: noEntry("nodot"),
  conditionsOnly: noEntry("condonly"),
  noEntry: noEntry("noentry"),
  mainMissing: entryMissing("nomain"),
  mainDirectory: entryMissing("maindir"),
  exportsMissing: entryMissing("exmiss"),
  exportsSubpathMissing: `The installed patpkg exports "patpkg/src/capability" from a file that is not there, so it is unbuilt or its install is broken. Rebuild patpkg, or remove it and install it again.`,
  patternTypo: `"patbuilt/src/capabilty" is not something the installed patbuilt provides. Check the version of patbuilt you have, or correct that import — ${NO_INSTALL}`,
  builtin: `"node:nope" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
  builtinSubpath: `"node:fs/promsies" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
  bunScheme: {
    default: `"bun:" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
    bun: `"nope" is not installed. ${INSTALL}, or correct that import.`,
  },
  local: `Nothing at "./src/x.js". Create that file or correct the import — ${NO_INSTALL}`,
  directory: `Nothing at "./src". Create that file or correct the import — ${NO_INSTALL}`,
  fileUrl: `Nothing at "./src/y.js". Create that file or correct the import — ${NO_INSTALL}`,
  hash: `"#internal" is not in the project's imports map. Add it to the imports field of package.json, or correct the import — ${NO_INSTALL}`,
  hashInPackage: `hashpkg imports "#internal", which its own imports map does not provide. Report this to its maintainer — ${NO_INSTALL}`,
  relativeInPackage: `relpkg is missing its own file "relpkg/missing.js". Report this to its maintainer — ${NO_INSTALL}`,
  dependencyAbsent: `deppkg imports "absentdep", which is not installed. ${INSTALL}. If it is still missing, deppkg does not declare it — report that to its maintainer.`,
  dependencyBuiltin: {
    default: `builtinpkg imports "node:nope", which this runtime does not provide. Run it on a runtime that has that module, or report this to its maintainer — ${NO_INSTALL}`,
    node: `"node:nope" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
    vite: `"node:nope" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`,
  },
  dependencyEntryMissing: `entrydep imports "exmiss", and ${entryMissing("exmiss").replace("The installed exmiss", "the installed exmiss")}`,
  // Bun loads both: it reads a module's syntax, not its package's "type". Pinned, so a Bun that starts
  // refusing them shows up here as a row to fill in.
  typeModuleCommonjsCode: { default: typeMismatch("cjsinesm"), bun: null },
  typeCommonjsModuleCode: { default: typeMismatch("esmincjs"), bun: null },
};

/** The kind the config loader and the vite plugin report. Every other case is an import that did not resolve. */
const KINDS: Partial<Record<Case, string>> = {
  typeModuleCommonjsCode: "package-load",
  typeCommonjsModuleCode: "package-load",
};

/** The remedy for a case from a source, or `null` where that runtime loads the case cleanly. */
function remedyFor(name: Case, source: Source): string | null {
  const expected = REMEDIES[name];
  if (typeof expected === "string") return expected;
  const own = expected[source];
  return own === undefined ? expected.default : own;
}

/** Stage {@link TREE} and one case file per import in a fresh directory, and return its real path. */
function stage(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-unresolved-")));
  for (const [path, text] of Object.entries(TREE)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const [name, specifier] of Object.entries(IMPORTS)) {
    writeFileSync(join(root, `case-${name}.js`), `import ${JSON.stringify(specifier.replace("<root>", root))};\n`);
  }
  for (const [name, text] of Object.entries(LOADS)) writeFileSync(join(root, `case-${name}.js`), text);
  return root;
}

const root = stage();
/** The child scripts live beside the tree, never in it, so nothing they are walks into a probe. */
const scripts = realpathSync(mkdtempSync(join(tmpdir(), "pithy-unresolved-scripts-")));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scripts, { recursive: true, force: true });
});

/** What one surface said: its kind and its `action`. */
interface Said {
  kind: string;
  action: string;
}

/** What every surface said for one case, by surface name. */
type Verdicts = Record<string, Said>;

const CONFIG_SURFACE = "pithy.config.ts (CLI)";
const CAPABILITY_SURFACE = "a capability loader (CLI)";
const VITE_SURFACE = "the vite plugin";

/** The two CLI classifiers, each told the same project. The capability loader is loading something else. */
function cliSurfaces(cause: unknown): Verdicts {
  return {
    [CONFIG_SURFACE]: classifyConfigLoadFailure(cause, root),
    [CAPABILITY_SURFACE]: classifyCapabilityLoadFailure("payments", "@pithy-sh/payments/src/capability", cause, root),
  };
}

const run = promisify(execFile);

/**
 * **Bun**: a Bun child imports every case and puts what it threw — the object itself, wrapper and all —
 * through both CLI classifiers, loaded from this repository's source.
 */
async function underBun(): Promise<Record<string, Verdicts | null>> {
  const script = join(scripts, "bun-surfaces.ts");
  const config = pathToFileURL(resolve(import.meta.dirname, "config.ts")).href;
  const capability = pathToFileURL(resolve(import.meta.dirname, "..", "capabilities", "loadFailure.ts")).href;
  writeFileSync(
    script,
    [
      `import { classifyConfigLoadFailure } from ${JSON.stringify(config)};`,
      `import { classifyCapabilityLoadFailure } from ${JSON.stringify(capability)};`,
      "const [root, ...names] = process.argv.slice(2);",
      "const out = {};",
      "for (const name of names) {",
      '  try { await import(root + "/case-" + name + ".js"); out[name] = null; }',
      "  catch (thrown) {",
      "    out[name] = {",
      `      ${JSON.stringify(CONFIG_SURFACE)}: classifyConfigLoadFailure(thrown, root),`,
      `      ${JSON.stringify(CAPABILITY_SURFACE)}: classifyCapabilityLoadFailure("payments", "@pithy-sh/payments/src/capability", thrown, root),`,
      "    };",
      "  }",
      "}",
      "console.log(JSON.stringify(out));",
    ].join("\n"),
  );
  const { stdout } = await run("bun", [script, root, ...ALL_CASES], { cwd: scripts });
  return JSON.parse(stdout) as Record<string, Verdicts | null>;
}

/**
 * **Node**: a Node child imports every case and hands back every string the thrown error carries — its
 * own properties and its prototypes', its `stack` among them, and the same of an `AggregateError`'s
 * `errors` and of a `cause` — which is everything a classifier could read. Rebuilt here as an `Error` with
 * those properties. The `stack` is the one place Node names the file a `"type"` mismatch threw from.
 */
async function underNode(): Promise<Record<string, Verdicts | null>> {
  const script = join(scripts, "node-causes.mjs");
  writeFileSync(
    script,
    [
      "function dump(e, depth) {",
      '  if (typeof e !== "object" || e === null) return e;',
      "  const out = {};",
      "  for (let o = e; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {",
      "    for (const k of Object.getOwnPropertyNames(o)) {",
      '      if (k in out || k === "constructor") continue;',
      "      let v; try { v = e[k]; } catch { continue; }",
      '      if (typeof v === "string") out[k] = v;',
      '      else if (k === "errors" && Array.isArray(v) && depth < 2) out[k] = v.map((x) => dump(x, depth + 1));',
      '      else if (k === "cause" && depth < 2) out[k] = dump(v, depth + 1);',
      "    }",
      "  }",
      "  return out;",
      "}",
      "const [root, ...names] = process.argv.slice(2);",
      "const out = {};",
      "for (const name of names) {",
      '  try { await import(new URL("file://" + root + "/case-" + name + ".js").href); out[name] = null; }',
      "  catch (thrown) { out[name] = dump(thrown, 0); }",
      "}",
      "console.log(JSON.stringify(out));",
    ].join("\n"),
  );
  const { stdout } = await run(process.execPath, ["--no-deprecation", script, root, ...ALL_CASES], { cwd: scripts });
  const causes = JSON.parse(stdout) as Record<string, Record<string, unknown> | null>;
  return Object.fromEntries(
    Object.entries(causes).map(([name, cause]) => [name, cause === null ? null : cliSurfaces(rebuilt(cause))]),
  );
}

/** A dumped error as an `Error` again, its strings and its nested errors where they were. */
function rebuilt(dumped: Record<string, unknown>): Error {
  const error = new Error(typeof dumped.message === "string" ? dumped.message : "");
  for (const [key, value] of Object.entries(dumped)) {
    const restored =
      key === "errors" && Array.isArray(value)
        ? value.map((inner) => rebuilt(inner as Record<string, unknown>))
        : key === "cause" && typeof value === "object" && value !== null
          ? rebuilt(value as Record<string, unknown>)
          : value;
    Object.defineProperty(error, key, { value: restored, enumerable: true, configurable: true, writable: true });
  }
  return error;
}

/** **Vite**: the plugin's own loader, in this process, and the refusal it throws. */
async function underVite(): Promise<Record<string, Verdicts | null>> {
  const out: Record<string, Verdicts | null> = {};
  for (const name of ALL_CASES) {
    try {
      await loadWorkerConfig(join(root, `case-${name}.js`));
      out[name] = null;
    } catch (thrown) {
      const payload = (thrown as { payload?: { action?: string; detail?: string } }).payload;
      const kind = payload?.detail?.split(":")[0] ?? "no payload";
      out[name] = { [VITE_SURFACE]: { kind, action: payload?.action ?? String(thrown) } };
    }
  }
  return out;
}

const verdicts: Partial<Record<Source, Record<string, Verdicts | null>>> = {};
beforeAll(async () => {
  [verdicts.bun, verdicts.node, verdicts.vite] = await Promise.all([underBun(), underNode(), underVite()]);
}, 120_000);

describe("every case, thrown by each surface's real loader, says one thing", () => {
  for (const name of CASES) {
    for (const source of SOURCES) {
      test(`${name}, thrown by ${SOURCE_NAME[source]}`, () => {
        const said = verdicts[source]?.[name];
        const remedy = remedyFor(name, source);
        if (remedy === null) {
          expect(said, "this runtime loads the case, and the table says so").toBeNull();
          return;
        }
        expect(said, "the case imported cleanly, so nothing was tested").toBeTruthy();
        for (const [surface, { kind, action }] of Object.entries(said ?? {})) {
          expect(action, surface).toBe(remedy);
          // Never the config's own throw, never a parse error: the failure is a package's, or an import's.
          if (surface !== CAPABILITY_SURFACE) expect(kind, surface).toBe(KINDS[name] ?? "unresolved-import");
          expect(kind, surface).not.toBe("unknown");
          expect(action, surface).not.toMatch(/threw while loading|does not parse/);
          // No rendered field carries a path or a URL, whatever the loader handed over.
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
    // An entry that is not on disk is that one package's to rebuild or reinstall, not the project's.
    const reinstalls = new Set<Case>([
      "mainMissing",
      "mainDirectory",
      "exportsMissing",
      "exportsSubpathMissing",
      "dependencyEntryMissing",
    ]);
    for (const name of CASES) {
      for (const source of SOURCES) {
        const remedy = remedyFor(name, source);
        if (remedy === null) continue;
        // Bun 1.4.2's `bun:nope` is the one a runtime takes out of our hands: see REMEDIES.
        const says = installs.has(name) || (name === "bunScheme" && source === "bun");
        expect(remedy.includes("bun install"), `${name} from ${source}`).toBe(says);
        if (reinstalls.has(name)) expect(remedy, `${name} from ${source}`).toContain("remove it and install it again");
        else if (!says) expect(remedy, `${name} from ${source}`).toContain(NO_INSTALL);
      }
    }
  });
});

/**
 * **A package is named for a file of its own that would not load, and only for that (#709).**
 *
 * Both halves read off what each real loader threw. A package whose file does not parse is that package's
 * fault, never the config's and never the capability being loaded. A package that loaded and then threw a
 * `SyntaxError` because the config handed it bad input is not: the adopter keeps the parser's reason.
 */
describe("a package's own file that would not load, and a package's deliberate throw", () => {
  const PARSE = `The installed badparse does not parse. Check the version of badparse you have, or report this to its maintainer — ${NO_INSTALL}`;

  test("on Bun, a package's file that does not parse is that package's, on every surface", () => {
    const said = verdicts.bun?.packageParse;
    expect(said, "Bun loaded a file that does not parse").toBeTruthy();
    for (const [surface, { kind, action }] of Object.entries(said ?? {})) {
      expect(action, surface).toBe(PARSE);
      if (surface !== CAPABILITY_SURFACE) expect(kind, surface).toBe("package-load");
      // Never the config's position: the line and column Bun gives are in the package's file.
      expect(action, surface).not.toMatch(/Line \d+, column \d+/);
    }
  });

  // Pinned: Node 24.21.0 throws this `SyntaxError` with only its own internal frames and no file anywhere
  // on it, and Vite hands a package's import to Node. A Node that starts naming the file turns this red.
  test("on Node and through Vite, the file is withheld, so no package is named", () => {
    for (const source of ["node", "vite"] as const) {
      const said = verdicts[source]?.packageParse;
      expect(said, `${source} loaded a file that does not parse`).toBeTruthy();
      for (const [surface, { kind }] of Object.entries(said ?? {})) {
        if (surface !== CAPABILITY_SURFACE) expect(kind, `${surface} from ${source}`).toBe("parse-error");
      }
    }
  });

  test("a SyntaxError a package's function throws at the config's call is never the package failing to load", () => {
    for (const source of SOURCES) {
      const said = verdicts[source]?.packageThrows;
      expect(said, `${source} loaded a config that throws`).toBeTruthy();
      for (const [surface, { kind, action }] of Object.entries(said ?? {})) {
        const where = `${surface} from ${SOURCE_NAME[source]}`;
        expect(kind, where).not.toBe("package-load");
        expect(action, where).not.toContain("fake5");
        // The parser's own reason reaches the adopter, wherever they read it.
        expect(action, where).toContain("JSON5: invalid character ',' at 1:2");
      }
    }
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
    // A package whose "type" its code contradicts is core's to name too, by the same rule.
    if (code.includes("in ES module scope")) found.push("a module-type sentence");
    if (code.includes("Cannot use import statement")) found.push("a module-type sentence");
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
