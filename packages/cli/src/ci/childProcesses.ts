// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";

/**
 * **Where the CLI starts a child process, found through the primitives rather than through a wrapper's name
 * (#593).**
 *
 * `ci/narration.test.ts` used to find a long command's subprocesses by the literal `runWrangler(`, and said
 * it found every captured one. It found one wrapper's callers. `bun add` for `pithy add`, `<pm> install`
 * for `pithy worker add` and `pithy feature create` all ran through `execFile` and all ran silent for
 * minutes, and the gate that claimed them could not see a single one. A needle made of a wrapper's name
 * holds until the second wrapper, and the second wrapper was already there.
 *
 * So this reads the **module specifier**, not a function name. Whatever a module calls its binding — a named
 * import, an `as` alias, a namespace, a default import, a destructured dynamic import, a `require`, a
 * `promisify` of any of those, a plain `const` copy of one — it came from `child_process`, and that string is
 * the one thing an alias cannot rename. From there it walks outward by *declaration*: a top-level declaration
 * that starts a captured child, or calls one that does, reaches it, and so does anything that calls *that*,
 * across modules and through `as` aliases and namespace imports, until something raises a step.
 *
 * **Nothing it cannot follow is ignored. It is reported.** Every occurrence of the specifier must be consumed
 * by an acquisition this module parses, and every occurrence of a binding it acquired must be a call, a
 * `typeof`, a property key, or its own declaration. A binding passed as a value (`helper(execFile)`, `{ spawn }`)
 * or a specifier held in a variable is a {@link ChildProcessReport.unfollowable} entry, and the gate fails on
 * those rather than guessing. That is how the reach is kept equal to the claim: a spelling this parser does
 * not know is a red build naming the file, not a silent pass.
 *
 * **What it does not see**, and the gate that reads it restates this where the next author looks:
 *
 * - **A specifier built at runtime.** `import("node:" + "child_process")`, `createRequire(…)("child_process")`
 *   and `process.binding("spawn_sync")` contain no whole specifier string to count.
 * - **A spawning library.** `execa`, `cross-spawn`, `tinyexec` start children without this module's name
 *   anywhere in the CLI's source. None is a dependency today; adding one is outside this walk.
 * - **`cluster.fork`.** Only `child_process` and Bun's global are primitives here.
 * - **A relative module named by anything but a literal.** An edge between two modules is a static
 *   `import`/`export … from`, or a dynamic `import()` whose specifier is one whole string or template
 *   literal. One that starts as a relative literal and is built from there — `` import(`../${name}`) ``,
 *   `import("../" + name)` — is reported. One that holds no relative literal at all — `import(spec)` with
 *   `spec` a `const` elsewhere, or `require("../dev/ports")` — is not seen: a planted
 *   `const spec = "../dev/ports"; await import(spec)` reaching a silent spawner passed. The CLI's own
 *   non-literal `import()`s all load an adopter's file by absolute URL, which no relative text could name.
 * - **Reference by text.** A declaration reaches another when it names it — a local name, an imported alias,
 *   `namespace.member`, or a namespace used bare. A shadowing local of the same name is read as a reference,
 *   which over-reports. A function handed in as a parameter is not followed to wherever its value was named.
 * - **Order inside a declaration.** A step anywhere in a declaration narrates every spawn the declaration
 *   reaches, before it or after it, and whatever the step names.
 * - **A top-level declaration's extent is read from column zero.** A declaration starts at a line beginning
 *   `export`, `const`, `function`, `class` and the like, and runs to the next one. Biome formats every module
 *   that way; a second declaration indented on the same level would be read as part of the first.
 */

/** The primitives a module can obtain from `child_process` that start a child. Anything else it exports does not. */
export const PRIMITIVES = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

/** One of {@link PRIMITIVES}, or Bun's own spawn. */
export type Primitive = (typeof PRIMITIVES)[number] | "Bun.spawn" | "Bun.spawnSync" | "Bun.$";

/** A place a module starts a child, as written. */
export interface CallSite {
  /** The primitive behind the call, however the binding at the site was spelled. */
  readonly primitive: Primitive;
  /** The executable argument as written: a string literal with its quotes, or the expression. */
  readonly executable: string;
  /** Offset into the module's code. */
  readonly offset: number;
}

/** A module's code, comments blanked, with where it lives. */
export interface SourceModule {
  /** Absolute path; relative specifiers resolve against it. */
  readonly file: string;
  /** Its code, comments blanked, offsets and newlines preserved. */
  readonly code: string;
}

/** A top-level declaration: the unit a step is raised in and a reference is made from. */
export interface Declaration {
  /** The module it is in. */
  readonly file: string;
  /** Its name; `default` for `export default`, `(module)` for the import header. */
  readonly name: string;
  /** The name another module imports it by — `default` for a default export — or null when it is not exported. */
  readonly exportedAs: string | null;
  /** Offset of its first character. */
  readonly start: number;
  /** Offset one past its last character. */
  readonly end: number;
}

/** What the walk found over a set of modules. */
export interface ChildProcessReport {
  /** Every call site of a primitive, by file. */
  readonly calls: ReadonlyMap<string, readonly CallSite[]>;
  /** Declarations that reach a child that must be narrated, and raise no step. Keyed `file#name`. */
  readonly silent: ReadonlySet<string>;
  /** Declarations that reach one and raise a step for it. Keyed `file#name`. */
  readonly narrated: ReadonlySet<string>;
  /** Every declaration, keyed `file#name`. */
  readonly declarations: ReadonlyMap<string, Declaration>;
  /** Why each reaching declaration reaches a child: the call it makes, or the silent name it calls. */
  readonly because: ReadonlyMap<string, string>;
  /** What the parser met and could not follow, as `file: what`. The gate fails on any. */
  readonly unfollowable: readonly string[];
}

/** How the walk decides which calls start a child that must be narrated. */
export interface ChildProcessPolicy {
  /**
   * Executables whose run is a bounded local query — reading git's metadata or the process table. Judged by
   * the literal executable at the call site, never by its argv.
   */
  readonly boundedExecutables: ReadonlySet<string>;
  /**
   * Modules whose `spawn` hands the child's streams on — to the terminal, to a log, or to nothing — rather
   * than collecting them. Only `spawn` there is exempt: `execFile`, `exec` and every `*Sync` collect output
   * by construction, so one of those in such a module is held like anywhere else.
   */
  readonly uncapturedModules: ReadonlySet<string>;
  /** The module that defines `startStep`. */
  readonly progressModule: string;
}

const SPECIFIER = String.raw`["'\x60](?:node:)?child_process["'\x60]`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

/** An identifier occurrence, not a property access, not inside a longer name, not inside a quote. */
function occurrences(code: string, name: string): number[] {
  const escaped = name.replace(/\$/g, "\\$");
  const found: number[] = [];
  for (const match of code.matchAll(new RegExp(String.raw`(?<![.\w$"'\x60])${escaped}(?![\w$"'\x60])`, "g"))) {
    found.push(match.index);
  }
  return found;
}

/** `local → imported` for a named-import clause body: `a, b as c, type T`. */
function namedClause(body: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const raw of body.split(",")) {
    const part = raw.trim().replace(/^type\s+/, "");
    if (part === "") continue;
    const alias = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(part);
    if (alias) names.set(alias[2] as string, alias[1] as string);
    else if (/^[\w$]+$/.test(part)) names.set(part, part);
  }
  return names;
}

/** `local → imported` for a destructuring pattern body: `a, b: c`. */
function destructureClause(body: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const raw of body.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const alias = /^([\w$]+)\s*:\s*([\w$]+)$/.exec(part);
    if (alias) names.set(alias[2] as string, alias[1] as string);
    else if (/^[\w$]+$/.test(part)) names.set(part, part);
  }
  return names;
}

/** Whether an occurrence at `at` of a `length`-long name is a property key or signature rather than a value. */
function isKey(code: string, at: number, length: number): boolean {
  if (!/^\s*\??\s*:/.test(code.slice(at + length, at + length + 8))) return false;
  return /(?:^|[{,;(])\s*$/.test(code.slice(code.lastIndexOf("\n", at - 1) + 1, at));
}

/** The regex source for a local name or a `namespace.member`, as a reference rather than a property or a longer name. */
function namePattern(name: string): string {
  const [head, member] = name.replace(/\$/g, "\\$").split(".");
  const tail = String.raw`(?![\w$])`;
  return member === undefined
    ? String.raw`(?<![.\w$"'\x60])${head}${tail}`
    : String.raw`(?<![.\w$])${head}\s*\.\s*${member}${tail}`;
}

/** The first argument of a call whose `(` is at `open`, as written. */
function firstArgument(code: string, open: number): string {
  return (/^\(\s*("[^"]*"|'[^']*'|[^,)]*)/.exec(code.slice(open))?.[1] ?? "").trim();
}

/** A module's child-process call sites and its own unfollowable uses. */
function scanPrimitives(module: SourceModule): { calls: CallSite[]; unfollowable: string[]; derivedExports: string[] } {
  const { code } = module;
  const bare = blankStrings(code);
  const calls: CallSite[] = [];
  const unfollowable: string[] = [];
  /** Spans that declare a binding; an occurrence inside one is the declaration, not a use. */
  const spans: [number, number][] = [];
  /** Local binding → the primitive it is. */
  const bindings = new Map<string, Primitive>();
  /** Local names that are the whole module. */
  const namespaces = new Set<string>();
  let consumed = 0;

  const primitiveOf = (imported: string): Primitive | null =>
    (PRIMITIVES as readonly string[]).includes(imported) ? (imported as Primitive) : null;

  // Static imports and re-exports.
  for (const match of code.matchAll(
    new RegExp(String.raw`\b(import|export)\s+(type\s+)?([^;"']*?)\s*from\s*${SPECIFIER}`, "g"),
  )) {
    consumed++;
    spans.push([match.index, match.index + match[0].length]);
    if (match[2]) continue;
    const clause = (match[3] as string).trim();
    if (match[1] === "export") {
      // A re-export hands the primitive to every importer under a name this module never calls.
      unfollowable.push(`re-exports child_process (${clause})`);
      continue;
    }
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const [local, imported] of namedClause(named[1] as string)) {
        const primitive = primitiveOf(imported);
        if (primitive) bindings.set(local, primitive);
      }
    }
    const head = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,\s*$/, "")
      .trim();
    const star = new RegExp(String.raw`^\*\s+as\s+(${IDENT})$`).exec(head);
    if (star) namespaces.add(star[1] as string);
    else if (new RegExp(`^${IDENT}$`).test(head)) namespaces.add(head);
  }

  // A bare `import "node:child_process"` binds nothing and starts nothing.
  for (const match of code.matchAll(new RegExp(String.raw`\bimport\s*${SPECIFIER}\s*;`, "g"))) {
    consumed++;
    spans.push([match.index, match.index + match[0].length]);
  }

  // Dynamic imports and requires bound to a name or a pattern.
  for (const match of code.matchAll(
    new RegExp(
      String.raw`\b(?:const|let|var)\s+(\{[^}]*\}|${IDENT})\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*${SPECIFIER}\s*\)`,
      "g",
    ),
  )) {
    consumed++;
    spans.push([match.index, match.index + match[0].length]);
    const target = match[1] as string;
    if (target.startsWith("{")) {
      for (const [local, imported] of destructureClause(target.slice(1, -1))) {
        const primitive = primitiveOf(imported);
        if (primitive) bindings.set(local, primitive);
      }
    } else namespaces.add(target);
  }

  // `(await import("node:child_process")).execFile(…)` — a primitive used where it is obtained.
  for (const match of code.matchAll(
    new RegExp(
      String.raw`\(\s*(?:await\s+)?(?:import|require)\s*\(\s*${SPECIFIER}\s*\)\s*\)\s*\.\s*(${IDENT})\s*(\()?`,
      "g",
    ),
  )) {
    consumed++;
    spans.push([match.index, match.index + match[0].length]);
    const primitive = primitiveOf(match[1] as string);
    if (primitive && match[2]) {
      calls.push({
        primitive,
        executable: firstArgument(code, match.index + match[0].length - 1),
        offset: match.index,
      });
    } else if (primitive) unfollowable.push(`uses child_process.${match[1]} without calling it`);
  }

  const census = [...code.matchAll(new RegExp(SPECIFIER, "g"))].length;
  if (census !== consumed) {
    unfollowable.push(
      `names child_process ${census} time(s) and ${consumed} of them are acquisitions this walk can parse`,
    );
  }

  // Destructuring out of a namespace: `const { execFile } = cp`.
  for (const ns of [...namespaces]) {
    for (const match of code.matchAll(
      new RegExp(String.raw`\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*${ns.replace(/\$/g, "\\$")}\s*;`, "g"),
    )) {
      spans.push([match.index, match.index + match[0].length]);
      for (const [local, imported] of destructureClause(match[1] as string)) {
        const primitive = primitiveOf(imported);
        if (primitive) bindings.set(local, primitive);
      }
    }
  }

  // Derivations, to a fixpoint: `const run = promisify(execFile)`, `const run = util.promisify(cp.execFile)`,
  // `const run = execFile;`.
  const derivedExports: string[] = [];
  const reference = (): string => {
    const names = [...bindings.keys()].map((name) => name.replace(/\$/g, "\\$"));
    const members = [...namespaces].map((ns) => String.raw`${ns.replace(/\$/g, "\\$")}\s*\.\s*${IDENT}`);
    return [...names, ...members].join("|");
  };
  for (let grew = true; grew && (bindings.size > 0 || namespaces.size > 0); ) {
    grew = false;
    const pattern = new RegExp(
      String.raw`(^|\n)(export\s+)?[ \t]*(?:const|let|var)\s+(${IDENT})\s*=\s*(?:(?:${IDENT}\s*\.\s*)?promisify\s*\(\s*(${reference()})\s*\)|(${reference()}))\s*;`,
      "g",
    );
    for (const match of code.matchAll(pattern)) {
      const local = match[3] as string;
      if (bindings.has(local)) continue;
      const source = ((match[4] ?? match[5]) as string).replace(/\s/g, "");
      const member = source.includes(".") ? (source.split(".").pop() as string) : null;
      const primitive = member ? primitiveOf(member) : (bindings.get(source) ?? null);
      if (!primitive) continue;
      bindings.set(local, primitive);
      spans.push([match.index, match.index + match[0].length]);
      if (match[2]) derivedExports.push(local);
      grew = true;
    }
  }

  const inSpan = (at: number): boolean => spans.some(([start, end]) => at >= start && at < end);

  for (const [local, primitive] of bindings) {
    for (const at of occurrences(bare, local)) {
      if (inSpan(at)) continue;
      const after = code.slice(at + local.length);
      if (/^\s*\(/.test(after)) {
        calls.push({
          primitive,
          executable: firstArgument(code, at + local.length + (/^\s*/.exec(after)?.[0].length ?? 0)),
          offset: at,
        });
        continue;
      }
      if (/typeof\s+$/.test(code.slice(Math.max(0, at - 10), at))) continue;
      if (isKey(bare, at, local.length)) continue;
      const immediate = /promisify\s*\(\s*$/.test(code.slice(Math.max(0, at - 40), at));
      const closed = /^\s*\)\s*\(/.exec(after);
      if (immediate && closed) {
        calls.push({
          primitive,
          executable: firstArgument(code, at + local.length + closed[0].length - 1),
          offset: at,
        });
        continue;
      }
      unfollowable.push(`uses ${local} (${primitive}) as a value at offset ${at}`);
    }
  }

  for (const ns of namespaces) {
    for (const at of occurrences(bare, ns)) {
      if (inSpan(at)) continue;
      const after = code.slice(at + ns.length);
      const member = new RegExp(String.raw`^\s*\.\s*(${IDENT})\s*(\()?`).exec(after);
      if (member) {
        const primitive = primitiveOf(member[1] as string);
        if (!primitive) continue;
        if (member[2]) {
          calls.push({ primitive, executable: firstArgument(code, at + ns.length + member[0].length - 1), offset: at });
          continue;
        }
        if (/typeof\s+$/.test(code.slice(Math.max(0, at - 10), at))) continue;
      }
      if (/typeof\s+$/.test(code.slice(Math.max(0, at - 10), at))) continue;
      unfollowable.push(`uses the child_process namespace ${ns} as a value at offset ${at}`);
    }
  }

  // Bun's own spawn, on the global.
  // Preceded by a `.` too, so `globalThis.Bun.spawn` is the same call.
  for (const match of bare.matchAll(/(?<![\w$])Bun(?![\w$])/g)) {
    const member = /^\s*\.\s*(spawn|spawnSync|\$)/.exec(bare.slice(match.index + 3));
    if (member) {
      const open = match.index + 3 + member[0].length;
      calls.push({
        primitive: `Bun.${member[1]}` as Primitive,
        executable: code[open] === "(" ? firstArgument(code, open) : code.slice(open, open + 20),
        offset: match.index,
      });
      continue;
    }
    if (/^\s*\./.test(bare.slice(match.index + 3))) continue;
    unfollowable.push(`uses the Bun global as a value at offset ${match.index}`);
  }

  return { calls, unfollowable, derivedExports };
}

/**
 * `code` with the text of every string and template literal blanked — quotes kept, offsets and newlines kept,
 * `${…}` expressions kept — so a word in a message is not read as a use of a binding.
 *
 * A regex literal is stepped over, told apart from division by the last significant character, the way
 * `blankComments` does it: a quote inside `/["']/` must not open a string.
 */
export function blankStrings(code: string): string {
  const out = code.split("");
  /** Open template literals, each with the brace depth of the expression it is inside, or -1 in its text. */
  const templates: number[] = [];
  let last = "";
  let i = 0;
  const blank = (at: number): void => {
    if (out[at] !== "\n") out[at] = " ";
  };
  while (i < code.length) {
    const ch = code[i] as string;
    const inTemplateText = templates.length > 0 && templates[templates.length - 1] === -1;
    if (inTemplateText) {
      if (ch === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (ch === "`") {
        templates.pop();
        last = "`";
        i++;
        continue;
      }
      if (ch === "$" && code[i + 1] === "{") {
        templates[templates.length - 1] = 0;
        last = "{";
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && code[j] !== "\n") {
        if (code[j] === "\\") {
          blank(j);
          j++;
        }
        blank(j);
        j++;
      }
      last = ch;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      templates.push(-1);
      i++;
      continue;
    }
    const depth = templates.at(-1);
    if (depth !== undefined && ch === "{") templates[templates.length - 1] = depth + 1;
    if (depth !== undefined && ch === "}") {
      templates[templates.length - 1] = depth === 0 ? -1 : depth - 1;
      if (depth === 0) {
        i++;
        continue;
      }
    }
    if (ch === "/" && (last === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== "\n") {
        if (code[j] === "\\") j++;
        else if (code[j] === "[") inClass = true;
        else if (code[j] === "]") inClass = false;
        else if (code[j] === "/" && !inClass) break;
        j++;
      }
      for (let k = i + 1; k < j; k++) blank(k);
      last = "/";
      i = j + 1;
      continue;
    }
    if (!/\s/.test(ch)) last = ch;
    i++;
  }
  return out.join("");
}

const DECLARATION = new RegExp(
  String.raw`^(export\s+)?(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum)\s+(${IDENT})|^export\s+default\b|^export\s*\{`,
  "gm",
);

/** A module's top-level declarations, in order, with the import header as `(module)`. */
export function declarations(module: SourceModule): Declaration[] {
  const starts: { name: string; exportedAs: string | null; start: number; typeOnly: boolean }[] = [];
  for (const match of module.code.matchAll(DECLARATION)) {
    const kind = match[3];
    const isDefault = match[0].startsWith("export default") || Boolean(match[2]);
    const name = match[4] ?? (isDefault ? "default" : "(exports)");
    starts.push({
      name,
      exportedAs: isDefault ? "default" : match[0].startsWith("export") && match[4] ? name : null,
      start: match.index,
      typeOnly: kind === "interface" || kind === "type",
    });
  }
  const found: Declaration[] = [];
  found.push({
    file: module.file,
    name: "(module)",
    exportedAs: null,
    start: 0,
    end: starts[0]?.start ?? module.code.length,
  });
  starts.forEach((entry, index) => {
    if (entry.typeOnly) return;
    found.push({
      file: module.file,
      name: entry.name,
      exportedAs: entry.exportedAs,
      start: entry.start,
      end: starts[index + 1]?.start ?? module.code.length,
    });
  });
  return found;
}

/** A value import from a relative specifier: which file, and `local → exported`, or a namespace. */
interface RelativeImport {
  readonly target: string;
  readonly names: ReadonlyMap<string, string>;
  readonly namespace: string | null;
  /** `export … from`: the names this module re-exports, `exported here → exported there`. */
  readonly reexports: ReadonlyMap<string, string> | "all" | null;
}

/** Resolve a relative specifier against a module to a file in `all`, or null. */
function resolveSpecifier(from: string, spec: string, all: ReadonlyMap<string, SourceModule>): string | null {
  const base = resolve(from, "..", spec.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (all.has(candidate)) return candidate;
  }
  return null;
}

/** Every relative value import and re-export in a module, aliases resolved. */
export function relativeImports(module: SourceModule, all: ReadonlyMap<string, SourceModule>): RelativeImport[] {
  const found: RelativeImport[] = [];
  for (const match of module.code.matchAll(/\b(import|export)\s+(type\s+)?([^;"']*?)\s*from\s*["'](\.[^"']*)["']/g)) {
    if (match[2]) continue;
    const target = resolveSpecifier(module.file, match[4] as string, all);
    if (!target) continue;
    const clause = (match[3] as string).trim();
    if (match[1] === "export") {
      if (/^\*$/.test(clause)) {
        found.push({ target, names: new Map(), namespace: null, reexports: "all" });
        continue;
      }
      const reexports = new Map<string, string>();
      for (const [local, imported] of namedClause(/\{([^}]*)\}/.exec(clause)?.[1] ?? ""))
        reexports.set(local, imported);
      found.push({ target, names: new Map(), namespace: null, reexports });
      continue;
    }
    const named = /\{([^}]*)\}/.exec(clause);
    const names = named ? namedClause(named[1] as string) : new Map<string, string>();
    const head = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,\s*$/, "")
      .trim();
    const star = new RegExp(String.raw`^\*\s+as\s+(${IDENT})$`).exec(head);
    let namespace: string | null = null;
    if (star) namespace = star[1] as string;
    else if (new RegExp(`^${IDENT}$`).test(head)) names.set(head, "default");
    found.push({ target, names, namespace, reexports: null });
  }
  return found;
}

/**
 * Relative dynamic imports: which file, at which offset — and every one this cannot resolve by its text.
 *
 * The specifier may be quoted either way or written as a template literal with nothing interpolated, which
 * Biome accepts and which is the same module. A relative specifier that is *not* one whole literal —
 * `` import(`../${name}`) ``, `import("../" + name)` — names a module only at runtime, so it is reported as
 * unfollowable rather than skipped: an edge dropped here is a command whose silent spawn nobody sees.
 */
function dynamicImports(
  module: SourceModule,
  all: ReadonlyMap<string, SourceModule>,
): { found: { target: string; at: number }[]; unfollowable: string[] } {
  const found: { target: string; at: number }[] = [];
  const unfollowable: string[] = [];
  for (const opened of module.code.matchAll(/\bimport\s*\(\s*(["'\x60])\./g)) {
    const quote = opened[1] as string;
    const whole = new RegExp(String.raw`^import\s*\(\s*${quote}(\.[^"'\x60\n]*)${quote}\s*\)`).exec(
      module.code.slice(opened.index),
    );
    const spec = whole?.[1];
    if (spec === undefined || (quote === "\x60" && spec.includes("${"))) {
      unfollowable.push(`imports a relative module by a specifier built at runtime at offset ${opened.index}`);
      continue;
    }
    const target = resolveSpecifier(module.file, spec, all);
    if (target) found.push({ target, at: opened.index });
  }
  return { found, unfollowable };
}

/** The local names in a module a declared export of `target` is reachable by, including through a namespace. */
function localReferences(code: string, imports: RelativeImport[], target: string, exported: string): string[] {
  const patterns: string[] = [];
  for (const entry of imports) {
    if (entry.target !== target) continue;
    for (const [local, name] of entry.names) if (name === exported) patterns.push(local);
    if (entry.namespace) patterns.push(`${entry.namespace}.${exported}`);
  }
  return patterns.filter((pattern) => mentions(code, pattern));
}

/** Whether `text` references a local name or a `namespace.member`. */
function mentions(text: string, pattern: string): boolean {
  return new RegExp(namePattern(pattern)).test(text);
}

/**
 * **The walk.** Every call site of a primitive, and every declaration that reaches one without a step.
 */
export function childProcessReport(
  all: ReadonlyMap<string, SourceModule>,
  policy: ChildProcessPolicy,
): ChildProcessReport {
  const calls = new Map<string, CallSite[]>();
  const unfollowable: string[] = [];
  const decls = new Map<string, Declaration>();
  const byFile = new Map<string, Declaration[]>();
  const imports = new Map<string, RelativeImport[]>();
  const dynamics = new Map<string, { target: string; at: number }[]>();
  /** `file#name` of every declaration that reaches a child directly or through something silent. */
  const reaching = new Set<string>();
  const narrates = new Set<string>();
  const because = new Map<string, string>();

  /** Each module's code with its import and re-export statements blanked, so a clause is not read as a use. */
  const references = new Map<string, string>();
  for (const module of all.values()) {
    references.set(
      module.file,
      blankStrings(module.code).replace(
        /\bimport\s+[^;"'()]*?from\s*["'][^"']*["']|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["'][^"']*["']/g,
        (statement) => statement.replace(/[^\n]/g, " "),
      ),
    );
  }

  for (const module of all.values()) {
    const scan = scanPrimitives(module);
    if (scan.calls.length > 0) calls.set(module.file, scan.calls);
    for (const entry of scan.unfollowable) unfollowable.push(`${module.file}: ${entry}`);
    const list = declarations(module);
    byFile.set(module.file, list);
    for (const decl of list) decls.set(`${module.file}#${decl.name}`, decl);
    imports.set(module.file, relativeImports(module, all));
    const dynamic = dynamicImports(module, all);
    dynamics.set(module.file, dynamic.found);
    for (const entry of dynamic.unfollowable) unfollowable.push(`${module.file}: ${entry}`);

    const own = (at: number): Declaration | undefined => list.find((decl) => at >= decl.start && at < decl.end);
    for (const call of scan.calls) {
      const bounded = /^["']([^"']*)["']$/.exec(call.executable)?.[1];
      if (bounded !== undefined && policy.boundedExecutables.has(bounded)) continue;
      if (call.primitive === "spawn" && policy.uncapturedModules.has(module.file)) continue;
      const decl = own(call.offset);
      if (!decl) continue;
      reaching.add(`${module.file}#${decl.name}`);
      because.set(`${module.file}#${decl.name}`, `starts ${call.primitive}(${call.executable})`);
    }
    for (const name of scan.derivedExports) {
      reaching.add(`${module.file}#${name}`);
      because.set(`${module.file}#${name}`, "exports a child_process primitive");
    }

    // A step: `startStep` from the progress module, under whatever local name or namespace it was imported as.
    const stepNames =
      module.file === policy.progressModule
        ? ["startStep"]
        : localReferences(module.code, imports.get(module.file) ?? [], policy.progressModule, "startStep");
    const text = references.get(module.file) ?? module.code;
    for (const decl of list) {
      const body = text.slice(decl.start, decl.end);
      if (stepNames.some((name) => new RegExp(String.raw`${namePattern(name)}\s*\(`).test(body))) {
        narrates.add(`${module.file}#${decl.name}`);
      }
    }
  }

  const silentOf = (key: string): boolean => reaching.has(key) && !narrates.has(key);

  /** A module's exported names that are silent, re-exports followed. */
  const silentExports = (file: string, seen = new Set<string>()): Set<string> => {
    const names = new Set<string>();
    if (seen.has(file)) return names;
    seen.add(file);
    const code = all.get(file)?.code ?? "";
    for (const decl of byFile.get(file) ?? []) {
      if (decl.exportedAs === null || !silentOf(`${file}#${decl.name}`)) continue;
      names.add(decl.exportedAs);
    }
    // `export { local as name }` lists.
    for (const match of code.matchAll(/^export\s*\{([^}]*)\}\s*;/gm)) {
      for (const [exported, local] of namedClause(match[1] as string)) {
        if (silentOf(`${file}#${local}`)) names.add(exported);
      }
    }
    for (const entry of imports.get(file) ?? []) {
      if (!entry.reexports) continue;
      const there = silentExports(entry.target, seen);
      if (entry.reexports === "all") for (const name of there) names.add(name);
      else for (const [here, name] of entry.reexports) if (there.has(name)) names.add(here);
    }
    return names;
  };

  for (let grew = true; grew; ) {
    grew = false;
    for (const module of all.values()) {
      const list = byFile.get(module.file) ?? [];
      // `export default` and an `export { … }` list have no name to be called by, so they are nobody's callee.
      const silentHere = list
        .filter((decl) => !/^(default|\(.*\))$/.test(decl.name) && silentOf(`${module.file}#${decl.name}`))
        .map((decl) => decl.name);
      const patterns: string[] = [...silentHere];
      for (const entry of imports.get(module.file) ?? []) {
        for (const name of silentExports(entry.target)) {
          patterns.push(...localReferences(module.code, [entry], entry.target, name));
        }
      }
      // A namespace used other than as `ns.member` — destructured, passed on — may be handing any member on.
      const bareNamespaces = (imports.get(module.file) ?? [])
        .filter((entry) => entry.namespace !== null && silentExports(entry.target).size > 0)
        .map((entry) => entry.namespace as string);
      const dynamicTargets = (dynamics.get(module.file) ?? []).filter((entry) => silentExports(entry.target).size > 0);
      for (const decl of list) {
        const key = `${module.file}#${decl.name}`;
        if (reaching.has(key)) continue;
        const body = (references.get(module.file) ?? module.code).slice(decl.start, decl.end);
        const own = decl.name === "(module)" ? [] : [decl.name];
        const pattern =
          patterns.find((candidate) => !own.includes(candidate) && mentions(body, candidate)) ??
          bareNamespaces.find((ns) => new RegExp(String.raw`${namePattern(ns)}(?!\s*\.)`).test(body));
        const dynamic = dynamicTargets.find((entry) => entry.at >= decl.start && entry.at < decl.end);
        if (pattern === undefined && dynamic === undefined) continue;
        reaching.add(key);
        because.set(key, pattern === undefined ? `imports ${dynamic?.target}` : `calls ${pattern}`);
        grew = true;
      }
    }
  }

  const silent = new Set([...reaching].filter((key) => !narrates.has(key)));
  const narrated = new Set([...reaching].filter((key) => narrates.has(key)));
  return { calls, silent, narrated, declarations: decls, because, unfollowable };
}
