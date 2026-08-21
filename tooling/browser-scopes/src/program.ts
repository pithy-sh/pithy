// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a browser's program actually contains, asked of the compiler that builds it.
 *
 * The rule is one sentence: **a module a browser may import reaches no module that needs the Workers
 * runtime.** `tsconfig.responses.json` compiles the response schemas with the DOM lib and `types: []`,
 * which answers half of it — whatever fails in a browser's ambient environment fails there. This file
 * answers the other half, and it answers it by asking `tsc` which files the program included rather
 * than by reading the source itself.
 *
 * ## Three spellings walked past a regex, and the fourth was the instrument (Jim, 2026-08-21)
 *
 * This was a walk over the import graph, `reach.ts`, and its argument deserves to be read before its
 * replacement is. It said this:
 *
 * > **One invariant, not a count of spellings.** […] So the split is by *what a program can refuse*,
 * > which is a property rather than a list: `tsc` under `types: []` owns everything that fails in a
 * > browser's ambient environment. This walk owns everything a program cannot refuse, cannot read as a
 * > fault, or never got to look at. […] Whatever turns up fourth is the walk's if it changes what a
 * > program *has*, and `tsc`'s if it fails under what a program *lacks*. That sentence is the rule.
 *
 * **The split is still right. The walk was not the thing to put on its far side.** Every clause above
 * survives into this file unchanged; what changed is who answers the second half. The walk answered it
 * by finding import specifiers with a regex over source text, and the regex was wrong three times in
 * two rounds:
 *
 * 1. `../link/sender.js`, which TypeScript's Bundler resolution follows to the `.ts` beside it. The
 *    resolver tried two candidates and dropped the rest in silence.
 * 2. `/// <reference types="@cloudflare/workers-types" />`, which the specifier pattern never matched
 *    and which `tsc` honours whatever `types: []` says.
 * 3. A comment inside a multi-line import list. The pattern was `^\s*(?:import|export)\b[^;]*?from…`,
 *    and `[^;]*?` means **one semicolon anywhere in the statement stops it matching at all**. Planted:
 *    `import {\n  MAX_LINKED_PURCHASES, // the cap on linked purchases; 25 rows\n} from "../link/sender";`
 *    re-attached the whole #419 chain under a response schema with `tsc -p tsconfig.responses.json` at
 *    exit 0 and the suite at 20 passed.
 *
 * Three is not a pattern of bad luck. **It is the instrument.** A regex over source text is a second,
 * hand-written model of TypeScript's grammar and of its module resolution, maintained beside the real
 * one, and the only thing it can ever be is behind. The same walk also failed in the other direction:
 * pointed at every module in `packages/` it threw on 53 of 1,912 — 30 of them on a phantom
 * `import config from "../pithy.config";` that lives **inside a scaffold template literal** in
 * `cli/src/project/workerScaffold.ts`, and 23 on `.json` imports, which `resolveJsonModule` makes real
 * compiler-followed edges. A walker that both misses real edges and invents edges that are not there is
 * not one patch from correct.
 *
 * So the walk is gone and the compiler answers. `tsc --listFilesOnly` reports **which files this program
 * actually included**, and every spelling above collapses into one question with one answer:
 *
 * - A named import of `@cloudflare/workers-types` puts its `index.ts` in the list.
 * - So does a subpath of it, and so does a `.js`-suffixed re-export three modules down.
 * - So does `/// <reference types="…" />`, because honouring the directive is *how* it defeats
 *   `types: []` — the injection and the entry in the list are the same event.
 * - A directive inside a template literal puts nothing in the list, because it is text the module
 *   emits, and the compiler does not read emitted text.
 * - A `.json` import puts a `.json` file in the list, under `packages/`, where it belongs.
 * - An unresolvable specifier is a diagnostic, which is the `typecheck` task's to report.
 *
 * There is no fourth spelling to find, because nothing here is spelled. The question asked is not "what
 * does this text look like it imports" but "what did the compiler open", and the compiler is the only
 * thing that has ever known the answer.
 *
 * **What was given up, honestly.** The walk printed a trail —
 * `support/src/http/responses.ts -> support/src/link/sender.ts -> auth/src/data/tables.ts` — and a file
 * list prints none. What replaces it is the root and the package: one program per response module names
 * *which capability* pulled the dependency in, and `typecheck`'s own diagnostics name the file and the
 * line whenever the fault is one a browser's environment can refuse. #419's report was
 * `packages/auth/src/data/tables.ts(35,34): error TS2552`, with no trail, and that was enough to fix it.
 * A trail derived from a model that is wrong three times in two rounds is not worth the model.
 *
 * ## What counts as a fault
 *
 * Everything the program included is one of three things, and the third is the fault:
 *
 * - **Ours.** A file under a directory the caller owns — `packages/` and this package. The compiler's
 *   own diagnostics judge these; their presence here is not a fault by itself.
 * - **A dependency.** A package under `node_modules`, named. This is the answer the gate asserts on, and
 *   it is asserted as an **allowlist**: the caller states which packages a browser build may have, and
 *   anything else fails. A blocklist of `@cloudflare/workers-types` would be the count-of-spellings
 *   mistake one level up — `wrangler`, `kysely-d1`, `@cloudflare/vitest-pool-workers` are all the same
 *   fault wearing other names, and a list of them is a list somebody is always one entry behind on. An
 *   allowlist fails closed: a package arriving that nobody argued for is red, and the fix is one line
 *   and a reason.
 * - **A stranger.** Anything else — a file under neither, which nobody has yet seen this program pull
 *   in. Reported rather than ignored, for the same reason.
 *
 * TypeScript's own `lib.*.d.ts` are neither, and are dropped: they are what `lib` in the tsconfig names,
 * so they are the browser's environment rather than something reached from it.
 *
 * Build-time tooling, in the class `packages/cli/src/ci/fileModes.ts` describes. Its errors are plain
 * `Error`s, not the `PithyError` the shipped runtime owes.
 */

/** This package's directory, reached without a literal that climbs — see `turboInputs.test.ts`. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** This package's own TypeScript, which is the one that resolves the kit through the workspace link. */
const TSC = join(PACKAGE_DIR, "node_modules", ".bin", "tsc");

/** A TypeScript-shipped library declaration: `lib.es2022.d.ts`, `lib.dom.d.ts`, and the rest. */
const LIB_FILE = /^lib\.[a-z0-9.]+\.d\.ts$/;

/** The packages TypeScript ships its own `lib` under. Platform-suffixed since the Go port. */
const TYPESCRIPT_PACKAGE = /^(?:typescript|@typescript\/)/;

/** What one DOM-only program included, sorted by where each file came from. */
export interface Included {
  /** Files under one of the caller's own directories, relative to the first of them. Sorted. */
  readonly ours: readonly string[];
  /** Every npm package the program reached, by name. Sorted, deduplicated. */
  readonly dependencies: readonly string[];
  /** Files that are neither, absolute. A shape nobody has seen, so a thing to look at. Sorted. */
  readonly strangers: readonly string[];
}

/** What to compile, and whose files are the subject. */
export interface BrowserProgram {
  /** The tsconfig whose options define "a browser's program". Extended, never restated. */
  readonly base: string;
  /** Absolute paths of the modules to put in the program. Every one lives under the first `ours`. */
  readonly roots: readonly string[];
  /**
   * Absolute directories whose files are the subject.
   *
   * The first is two things at once: what `ours` paths are reported relative to, and the `rootDir` the
   * generated project declares. The base tsconfig's own `rootDir` is `src`, which no root here is
   * under, and a `rootDir` nothing is under is `TS6059` on every file in the program.
   */
  readonly ours: readonly string[];
}

/** Whether `path` is inside `dir`. */
function inside(dir: string, path: string): boolean {
  return !relative(dir, path).startsWith("..");
}

/**
 * The npm package a path belongs to, or null when it is not installed code.
 *
 * The **last** `node_modules` segment, because bun's store nests: a path under
 * `node_modules/.bun/@cloudflare+workers-types@5…/node_modules/@cloudflare/workers-types/` belongs to
 * the inner name and not to `.bun`.
 */
function packageOf(path: string): string | null {
  const parts = path.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return null;
  const first = parts[at + 1];
  if (first === undefined) return null;
  const second = parts[at + 2];
  return first.startsWith("@") && second !== undefined ? `${first}/${second}` : first;
}

/**
 * Every file `tsc` opened for this program, as the compiler reports them.
 *
 * A failing compile still lists its files, and the verdict belongs to the `typecheck` task — reporting it
 * here as well would name one defect twice and would make the file list unavailable exactly when it is
 * most wanted. Whatever the exit code, the list is on stdout, which `execFileSync` hands back on the
 * error too.
 *
 * **`--listFilesOnly`, and two lines of defence behind it (Jim, 2026-08-21).** This was `--listFiles`
 * first, and a full check writes its diagnostics to the same stream. Pointed at all 1,912 modules in
 * `packages/` — most of which do not compile in a browser's environment, which is the point — it reported
 * 88 "files" that were error text: `'T' could be instantiated with an arbitrary type…` and
 * `Imported via "../../compatibility" from file '…'`. Reading a diagnostic as a path is the same class of
 * mistake as reading prose as an import, one layer down from the one this file was written to end.
 * `--listFilesOnly` skips the check, so there are no diagnostics to confuse — and every line is still
 * held to being an absolute path that exists, because a config error can still speak on that stream and a
 * line that is not a file on disk is not a file the compiler opened.
 */
function listFiles(base: string, roots: readonly string[], rootDir: string): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "pithy-browser-program-"));
  try {
    const project = join(scratch, "tsconfig.json");
    writeFileSync(
      project,
      // `extends` so the options are the ones under gate rather than a second copy of them. `include`
      // is emptied because the base names its own file, and `rootDir` is moved because the roots are
      // outside the base's package.
      JSON.stringify({
        extends: base,
        compilerOptions: { rootDir },
        include: [],
        files: [...roots],
      }),
      "utf8",
    );
    let stdout: string;
    try {
      stdout = execFileSync(TSC, ["-p", project, "--listFilesOnly"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (cause) {
      stdout = (cause as { stdout?: string }).stdout ?? "";
    }
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => isAbsolute(line) && existsSync(line));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Compiles `roots` under `base`'s options and reports what the program included.
 *
 * The one call every assertion in this package goes through. Nothing here parses TypeScript, resolves a
 * specifier, or knows what an import looks like.
 */
export function browserProgram(program: BrowserProgram): Included {
  const home = program.ours[0] as string;
  for (const root of program.roots) {
    if (!inside(home, root)) throw new Error(`${root} is not under ${home}, so no rootDir covers this program.`);
  }

  const ours: string[] = [];
  const dependencies = new Set<string>();
  const strangers: string[] = [];

  for (const file of listFiles(program.base, program.roots, home)) {
    // Installed code first, and not by location. A workspace link puts `node_modules` *inside* a
    // package directory, so asking "is this under `packages/`" before "is this installed" would file
    // a dependency reached through one as kit source.
    const dependency = packageOf(file);
    if (dependency !== null) {
      if (!(TYPESCRIPT_PACKAGE.test(dependency) && LIB_FILE.test(basename(file)))) dependencies.add(dependency);
      continue;
    }
    if (program.ours.some((dir) => inside(dir, file))) ours.push(relative(home, file));
    else strangers.push(file);
  }

  return {
    ours: [...new Set(ours)].sort(),
    dependencies: [...dependencies].sort(),
    strangers: [...new Set(strangers)].sort(),
  };
}
