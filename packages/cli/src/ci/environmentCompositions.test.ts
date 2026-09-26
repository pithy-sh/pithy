// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, posix, relative } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **A composition for an environment is composed for that environment, and by one primitive (#595).**
 *
 * A Worker's `pithy.config.ts` is code that may ask which environment it is composed for. Three producers
 * had asked it on the adopter's behalf by stamping `ENVIRONMENT` themselves (`ui/routeAllowlist.ts`,
 * `capabilities/secretApplicability.ts`), and every other command that composed for an environment asked
 * nothing — so `pithy migrate --env staging` applied the migrations of a composition for none. The rule
 * now lives in `project/composeFor.ts`, and this file holds the tree to it in four halves, each stated as
 * what must be true:
 *
 * 1. **`ENVIRONMENT` is written into this process by the primitive alone.** A module that writes
 *    `process.env` and names the variable is the primitive, or it is a second statement of the rule.
 * 2. **Every module that composes Workers through a loader `project/config.ts` or `project/workerScope.ts`
 *    exports, without the primitive, is named here, with why its composition is not for one environment**
 *    ({@link RAW_COMPOSERS}). A module naming a raw loader lands in the table
 *    or fails; a table entry whose module stopped naming one fails too, so the table cannot drift into a
 *    list of reasons nobody re-reads (#211).
 *
 *    **A composition carried out of a third module is followed (#595).** Every exported function anywhere
 *    in the tree that reaches a raw loader — directly, through a helper in its own module, or through another
 *    such function — is a carrier ({@link carriers}), and each is named in {@link SEALED} or
 *    {@link CARRYING}. A sealed one hands back an answer, never a composition, so its callers inherit
 *    nothing. Every other one is a raw loader in its own right, and every module naming it is held to this
 *    half. `commands/add.ts`'s `targetWorker` handed `pithy remove --drop` a composition for no environment
 *    through exactly that gap.
 *
 *    **A carrier is whatever a module hands out, however it is spelled (#595).** The walk read only
 *    `export function` and `export const`, so a helper exported through a list
 *    (`export { composedConfig as workerComposition }`, the form `commands/token.ts` and `commands/doctor.ts`
 *    already use) or as a default escaped it, and so did its importers. Every way a name leaves a module is
 *    now read ({@link moduleShape}): its own `export`, an export list with or without renames, `export default`
 *    of a declaration, a name or an expression, `export { a as b } from`, `export * from` and
 *    `export * as ns from`, a `class`, a `let` assigned later by a plain `=`, and a flat destructuring. A
 *    default export has no name its importers must use, so its importers are held by the specifier they import
 *    it from, a directory's `index.ts` among them. Inside a module, a declaration reaches through a carrier
 *    renamed at its import, a default or namespace import of a module that carries, and an `import()` of one.
 * 3. **Every module that assembles a backend does it inside the primitive.** `createBackend` is where a
 *    capability reads the environment at registration — the dev-login route is mounted there or not — so
 *    assembling one with no environment stamped is the #255 defect.
 * 4. **Every module that imports a computed specifier is named here** ({@link COMPUTED_IMPORTS}). A config
 *    is evaluated by importing it, and an adopter's path is never a string literal in this tree, so a
 *    module that reaches a config without any loader at all still has to import something computed.
 *
 * ## What this does not see, said plainly
 *
 * Each spelling below was planted and left this file green; a bullet naming no spelling is a boundary. A
 * gate believed to cover more than it does is worse than a narrow one somebody plans around.
 *
 * - **Module granularity, not call-site granularity.** A module in {@link RAW_COMPOSERS} may add a second
 *   raw composition, for an environment, beside the one its reason describes, and pass — planted as a
 *   `loadWorkerConfig(dir)` appended to `project/envInventory.ts`. Half 3 likewise
 *   passes a module that assembles one backend inside the primitive and a second outside it. Reading call
 *   sites wants a binding analysis rather than a wider regex.
 * - **A seal is a sentence, not a proof.** A carrier in {@link SEALED} is believed to hand back an answer. If
 *   it hands back a composition after all — a field of its result that is a capability instance — its
 *   callers are not held. The table is where that is checked, by a reviewer.
 * - **Carriers by name, not by binding.** A carrier's name is matched in every module, so a module declaring
 *   its own unrelated function or variable of the same name is held as if it called the carrier (a false red,
 *   never a false green). A carrier passed as a value — stored in an object, handed to a function — and called
 *   under another name is followed only as far as the module that names it. A carrier named only as the first
 *   branch of a ternary (`flag ? resolveWorkers : other`) is read as a property key, because `name :` is one,
 *   and is not matched at all.
 * - **Top-level declarations, by layout.** A carrier is declared at column 0, the way biome formats one. An
 *   exported `let` assigned inside a top-level block (`{ load = … }`) or an immediately invoked function, and
 *   a nested destructuring (`export const { a: { b } } = …`), bind no text this reads. A name assigned later is
 *   read by a plain `=` only: a logical assignment (`load ??= …`, `||=`, `&&=`) binds nothing. An exported
 *   object filled after its declaration, by `Object.assign(loaders, { … })` or `loaders["load"] = …`, carries
 *   nothing, because neither line is a declaration. An export list naming a string literal
 *   (`export { load as "load" }`) exports nothing this reads. A class is followed by its name, not by its
 *   members: `Loader.load(…)` is held because it names `Loader`.
 * - **Specifiers this CLI resolves.** A whole or default import is resolved when its specifier is relative or
 *   `@pithy-sh/cli/src/…`. A path alias would name a module this cannot find, and its importer is held only if
 *   it also names a carrier.
 * - **Which environment.** `composeFor("dev", …)` in a command about staging reaches the primitive and
 *   passes. The environments this CLI composes for are held by behavior —
 *   `migrations/environmentComposition.test.ts` — not by source text.
 * - **A variable name assembled at runtime.** `process.env[["ENVIRON", "MENT"].join("")] = env` names
 *   nothing half 1 reads, and a helper in another module handed a bare `process.env` object to write into
 *   is a write this file sees only where that module also names the variable.
 * - **A config reached by `require`, or by a loader library.** The CLI is ESM and loads configs through
 *   `import()`; a `createRequire` or a `jiti` would compose a config invisibly to half 4.
 * - **Only `packages/cli/src`.** The root `pithy.config.ts` (`loadProject`) composes no Worker and is out
 *   of scope; so is every other package.
 *
 * It reads comment-blanked source, because every docblock on this subject quotes what it is about.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/** The primitive. It defines the stamp, and it is the one module allowed to write it. */
const PRIMITIVE = "project/composeFor.ts";

/** The primitive's exports, any of which is a composition through it. */
const PRIMITIVE_EXPORTS =
  /\b(?:composeFor|composeForSync|resolveWorkersFor|resolveSingleWorkerFor|resolveWorkerSetFor|projectCapabilitySetFor)\b/;

/** The modules that define the Worker loaders: a config's evaluation, and the resolvers over it. */
const LOADER_MODULES: readonly string[] = ["project/config.ts", "project/workerScope.ts"];

/** The loader every other one reaches: the evaluation of one Worker's `pithy.config.ts`. */
const EVALUATES_A_WORKER_CONFIG = "loadWorkerConfig";

/** One top-level declaration: the local name it binds, and its text. */
interface Declaration {
  name: string;
  text: string;
}

/** What one module declares at top level, and every name it hands to another module. */
interface ModuleShape {
  declarations: Declaration[];
  /** Each local name, and every name it is exported under — `default` among them. */
  exports: Map<string, string[]>;
  /** `export { name as exported } from "…"`: another module's export, handed on under a name of this one's. */
  reexports: { name: string; exported: string; from: string }[];
  /** `export * from "…"`, and `export * as name from "…"`. */
  stars: { from: string; as: string | null }[];
}

/**
 * The lines of `code` that open inside a template literal, which a column-0 line there does not start a
 * declaration from. A `${…}` inside the template is code again, to its matching brace. A string or a regex
 * literal is skipped whole, so a backtick inside one opens nothing; a `/` is a regex where a value may start,
 * the same rule `blankComments` reads by.
 */
function templateLines(code: string): Set<number> {
  const inside = new Set<number>();
  const stack: ("template" | number)[] = [];
  let line = 0;
  let quote: string | null = null;
  let previous = "";
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] as string;
    if (char === "\n") {
      line += 1;
      if (stack.at(-1) === "template") inside.add(line);
      if (quote !== null) quote = null;
      continue;
    }
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === "[" && quote === "/") quote = "]";
      else if (char === quote) quote = quote === "]" ? "/" : null;
      continue;
    }
    if (stack.at(-1) !== "template" && !/\s/.test(char)) {
      const before = previous;
      previous = char;
      if (char === "/" && (before === "" || "(,=:[!&|?{};+-*%^~<>".includes(before))) {
        quote = "/";
        continue;
      }
    }
    const top = stack.at(-1);
    if (top === "template") {
      if (char === "\\") index += 1;
      else if (char === "`") stack.pop();
      else if (char === "$" && code[index + 1] === "{") {
        stack.push(0);
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "`") stack.push("template");
    else if (typeof top === "number" && char === "{") stack[stack.length - 1] = top + 1;
    else if (typeof top === "number" && char === "}") {
      if (top === 0) stack.pop();
      else stack[stack.length - 1] = top - 1;
    }
  }
  return inside;
}

/** The local names one flat destructuring pattern binds: `a`, `key: a`, `a = fallback`, `...rest`. */
function bindingNames(pattern: string): string[] {
  return pattern
    .split(",")
    .map((part) => /([\w$]+)\s*(?:=[^,]*)?$/.exec(part.split(":").pop()?.trim() ?? "")?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Add `exported` to the names `local` is exported under. */
function exportAs(exports: Map<string, string[]>, local: string, exported: string): void {
  exports.set(local, [...(exports.get(local) ?? []), exported]);
}

/**
 * Every top-level declaration a module makes, with its text, and every name it exports.
 *
 * Read by layout rather than by parse: biome opens a top-level declaration at column 0 and closes it
 * there, so a declaration runs to the next line that starts with anything but whitespace or a closer.
 * Comments are already blanked, so a docblock never starts one, and a line opening inside a template
 * literal is the template's text, not a declaration.
 *
 * A declaration is a `function`, a `class`, a `const`, `let` or `var`, an assignment to a name bound
 * earlier (`composed = async (dir) => …`), or an `export default` of anything — named `default` when it
 * binds no name of its own. Exported by its own `export`, by an export list (`export { a as b }`), or
 * handed on from another module (`export { a as b } from`, `export * from`, `export * as ns from`).
 */
function moduleShape(code: string): ModuleShape {
  const templates = templateLines(code);
  const declarations: Declaration[] = [];
  const exports = new Map<string, string[]>();
  let current: { names: string[]; lines: string[] } | null = null;
  const close = () => {
    for (const name of current?.names ?? []) declarations.push({ name, text: current?.lines.join("\n") ?? "" });
  };
  code.split("\n").forEach((line, index) => {
    if (!templates.has(index) && /^[^\s})\]]/.test(line)) {
      close();
      const head =
        /^(export\s+(default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+function\s*\*?\s*|function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([\w$]+)/.exec(
          line,
        );
      const destructured = /^(export\s+)?(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/.exec(line);
      const assigned = /^([\w$]+)(?:\.[\w$]+)*\s*=(?![=>])/.exec(line);
      const names =
        head !== null
          ? [head[3] as string]
          : destructured !== null
            ? bindingNames(destructured[2] as string)
            : /^export\s+default\b/.test(line)
              ? ["default"]
              : assigned !== null
                ? [assigned[1] as string]
                : [];
      current = names.length === 0 ? null : { names, lines: [] };
      const exported = head?.[1] ?? destructured?.[1];
      for (const name of names) {
        if (exported !== undefined) exportAs(exports, name, head?.[2] === undefined ? name : "default");
        else if (name === "default") exportAs(exports, name, "default");
      }
    }
    current?.lines.push(line);
  });
  close();

  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length - 1;
  const reexports: ModuleShape["reexports"] = [];
  for (const list of code.matchAll(/^export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/gm)) {
    if (templates.has(lineOf(list.index))) continue;
    for (const specifier of (list[1] as string).split(",")) {
      const parts = /^\s*(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(specifier);
      if (parts === null || parts[1] !== undefined) continue;
      const name = parts[2] as string;
      const exported = parts[3] ?? name;
      if (list[2] === undefined) exportAs(exports, name, exported);
      else reexports.push({ name, exported, from: list[2] });
    }
  }
  const stars: ModuleShape["stars"] = [];
  for (const star of code.matchAll(/^export\s*\*\s*(?:as\s+([\w$]+)\s+)?from\s*["']([^"']+)["']/gm)) {
    if (!templates.has(lineOf(star.index))) stars.push({ from: star[2] as string, as: star[1] ?? null });
  }
  return { declarations, exports, reexports, stars };
}

/** Each module's shape, read once: the tree does not change under a test run. */
const shapes = new Map<string, ModuleShape>();
function shapeOf(key: string): ModuleShape {
  let shape = shapes.get(key);
  if (shape === undefined) {
    shape = moduleShape(MODULES.find((module) => module.key === key)?.code ?? "");
    shapes.set(key, shape);
  }
  return shape;
}

/**
 * The module a relative specifier in `from` names, as the tables spell it, or `null` for a package.
 *
 * The CLI resolves as a bundler does, so a specifier naming a directory is its `index.ts`: `<path>.ts` when the
 * tree has that module, `<path>/index.ts` when it has that one instead. A specifier naming neither resolves to
 * `<path>.ts`, which matches no module. `tree` is the modules that exist, the CLI's own unless a test says.
 */
function resolveSpecifier(
  from: string,
  specifier: string,
  tree: readonly string[] = MODULES.map((module) => module.key),
): string | null {
  const own = "@pithy-sh/cli/src/";
  const path = specifier.startsWith(own)
    ? specifier.slice(own.length)
    : specifier.startsWith(".")
      ? posix.join(posix.dirname(from), specifier)
      : null;
  if (path === null) return null;
  const bare = path.replace(/\/+$/, "").replace(/\.[cm]?[jt]s$/, "");
  const index = `${bare}/index.ts`;
  return !tree.includes(`${bare}.ts`) && tree.includes(index) ? index : `${bare}.ts`;
}

/**
 * **Every loader that composes Workers with no environment stamped, derived from the modules that define
 * them** — never a list typed here.
 *
 * The list typed here was four names long and the defining module exported six loaders:
 * `resolveWorkerSet` and `projectCapabilitySet` compose every Worker exactly as `resolveWorkers` does, and
 * `commands/feature.ts`, `commands/token.ts` and `audit/cliAudit.ts` spent them unlisted while this gate was
 * green. So the set is the evaluation itself plus every top-level function in {@link LOADER_MODULES} that
 * reaches one already in it, to a fixed point, and a loader added beside them next year is in it by being
 * written. Only the exported ones are importable, so only they are matched elsewhere.
 */
function rawLoaders(): string[] {
  const declared = LOADER_MODULES.flatMap((key) => shapeOf(key).declarations);
  const raw = rawLocals(declared);
  return LOADER_MODULES.flatMap((key) =>
    [...shapeOf(key).exports].flatMap(([local, names]) => (raw.has(local) ? names : [])),
  )
    .filter((name) => name !== "default")
    .sort();
}

/** The local names in {@link LOADER_MODULES} that reach the evaluation, to a fixed point. */
function rawLocals(declared: readonly Declaration[]): Set<string> {
  const raw = new Set([EVALUATES_A_WORKER_CONFIG]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, text } of declared) {
      if (raw.has(name)) continue;
      const body = text.slice(text.indexOf(name) + name.length);
      if (namesIdentifier([...raw]).test(body)) {
        raw.add(name);
        grew = true;
      }
    }
  }
  return raw;
}

/** Whether a loader module's default export reaches the evaluation. */
function loaderModuleDefaults(): string[] {
  const raw = rawLocals(LOADER_MODULES.flatMap((key) => shapeOf(key).declarations));
  return LOADER_MODULES.filter((key) =>
    [...shapeOf(key).exports].some(([local, names]) => raw.has(local) && names.includes("default")),
  );
}

/**
 * A module that names a Worker loader which composes for no environment on its own.
 *
 * **By name, not by call shape**, so `import { resolveWorkers as every }` is caught at the import that has
 * to exist for any spelling of the call. Two positions are not a use and are skipped: a property key
 * (`resolveWorkers?: (…) => …`, a seam's type) and a member read (`options.resolveWorkers`, a seam's
 * value) — both name somebody else's resolver, and the default they fall back to is what gets read.
 *
 * **Skipping those two opened a hole, and {@link takesWhole} closes it.** Planted:
 * `const { resolveWorkers: all } = await import("./workerScope")` is a key by shape, and
 * `import * as scope from "./workerScope"` then `scope.resolveWorkers(…)` is a member read by shape — both
 * real compositions, both green. What neither can avoid is taking the whole defining module, by namespace or
 * by `import()`, so that is what is matched. Nothing in the tree does either today.
 */
function rawLoaderPattern(): RegExp {
  return namesAny(carriers().loaders);
}

/**
 * **Every export that composes Workers with no environment stamped and hands something back, anywhere in the
 * tree** — keyed `module#exported`, derived to a fixed point.
 *
 * A declaration reaches a raw loader when its text names one, names a declaration of its own module that
 * does, or names a carrier another module exports that is not sealed. Every name it is exported under is a
 * carrier, and so is every name another module hands it on under. A sealed carrier stops the walk in its own
 * module as well as in others, because what reaches its callers is its answer.
 *
 * `loaders` are the carriers matched by name. A default export has no name its importers must use, so a
 * module with one that carries is in `defaults`, and its importers are matched by the specifier instead.
 *
 * Within a module, a declaration also reaches through what the module imported under a name of its own: a
 * carrier renamed at its import (`{ resolveWorkers as every }`), a default import of a module whose default
 * carries, a namespace import of a module that carries, and an `import()` of one in the declaration's text.
 */
function carriers(): Carriers {
  derived ??= deriveCarriers();
  return derived;
}

interface Carriers {
  keys: string[];
  loaders: string[];
  /** Every module with a carrier that is not sealed: a namespace import or `import()` of it composes raw. */
  modules: string[];
  /** Every module whose default export carries and is not sealed. */
  defaults: string[];
}

/** The walk behind {@link carriers}, taken once: the tree does not change under a test run. */
let derived: Carriers | undefined;

function deriveCarriers(): Carriers {
  const raw = rawLoaders();
  const loaders = new Set(raw);
  const found = new Set<string>();
  const unsealed = new Set<string>();
  const skip = new Set([PRIMITIVE, ...LOADER_MODULES]);
  /** Record one carrier, and whether that was news. */
  const carry = (module: string, exported: string): boolean => {
    const key = `${module}#${exported}`;
    if (found.has(key)) return false;
    found.add(key);
    if (!(key in SEALED)) {
      unsealed.add(key);
      if (exported !== "default") loaders.add(exported);
    }
    return true;
  };
  /** The unsealed names `module` exports that carry, a loader module's raw loaders among them. */
  const carriedBy = (module: string): string[] =>
    LOADER_MODULES.includes(module)
      ? [...raw, ...(loaderModuleDefaults().includes(module) ? ["default"] : [])]
      : [...unsealed].filter((key) => key.startsWith(`${module}#`)).map((key) => key.slice(module.length + 1));
  const moduleOf = (key: string) => key.slice(0, key.indexOf("#"));
  /** The modules that carry so far, whole and by default. */
  const carryingNow = (): Carrying => ({
    modules: [...LOADER_MODULES, ...new Set([...unsealed].map(moduleOf))],
    defaults: [...loaderModuleDefaults(), ...[...unsealed].filter((key) => key.endsWith("#default")).map(moduleOf)],
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const module of MODULES) {
      if (skip.has(module.key)) continue;
      const shape = shapeOf(module.key);
      const sealed = (local: string) =>
        (shape.exports.get(local) ?? []).some((exported) => `${module.key}#${exported}` in SEALED);
      const carrying = carryingNow();
      const aliases = importedAliases(module.code, module.key, carrying, carriedBy);
      const reaching = new Set<string>();
      for (let local = true; local; ) {
        local = false;
        const via = [...loaders, ...aliases, ...[...reaching].filter((name) => name !== "default" && !sealed(name))];
        for (const { name, text } of shape.declarations) {
          if (reaching.has(name)) continue;
          const body = text.slice(text.indexOf(name) + name.length);
          if ((via.length > 0 && namesAny(via).test(body)) || takesWhole(body, module.key, carrying)) {
            reaching.add(name);
            local = true;
          }
        }
      }
      for (const name of reaching) {
        for (const exported of shape.exports.get(name) ?? []) if (carry(module.key, exported)) grew = true;
      }
      // An export list handing on a name this module imported rather than declared: `export { every as all }`.
      for (const [local, names] of shape.exports) {
        if (shape.declarations.some((declaration) => declaration.name === local)) continue;
        if (!loaders.has(local) && !aliases.includes(local)) continue;
        for (const exported of names) if (carry(module.key, exported)) grew = true;
      }
      for (const { name, exported, from } of shape.reexports) {
        const target = resolveSpecifier(module.key, from);
        if (target !== null && carriedBy(target).includes(name) && carry(module.key, exported)) grew = true;
      }
      for (const { from, as } of shape.stars) {
        const target = resolveSpecifier(module.key, from);
        const handed = target === null ? [] : carriedBy(target).filter((name) => name !== "default");
        for (const exported of as === null ? handed : handed.length > 0 ? [as] : []) {
          if (carry(module.key, exported)) grew = true;
        }
      }
    }
  }
  return {
    keys: [...found].sort(),
    loaders: [...loaders].sort(),
    modules: [...new Set([...unsealed].map(moduleOf))].sort(),
    defaults: [
      ...new Set([...[...unsealed].filter((key) => key.endsWith("#default")).map(moduleOf), ...loaderModuleDefaults()]),
    ].sort(),
  };
}

/**
 * An identifier as the text of a RegExp. `$` is an identifier character and an anchor, so `zzLoad$` unescaped
 * matches nowhere; and `\b` after it needs a word character next, so the end is spelled as "no identifier
 * character follows" instead of a word boundary.
 */
function identifiers(names: readonly string[]): string {
  return `(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w$])`;
}

/** Any of `names` as a whole identifier: not a member read, and not the tail of a longer name. */
function namesIdentifier(names: readonly string[]): RegExp {
  return new RegExp(`(?<![.\\w$])${identifiers(names)}`);
}

/**
 * A use of any of `names`: not a member read, not a property key, and not a type query. `typeof resolveWorkers`
 * names a loader's shape and composes nothing.
 */
function namesAny(names: readonly string[]): RegExp {
  return new RegExp(`(?<![.\\w$])(?<!typeof\\s+)${identifiers(names)}(?!\\s*\\??\\s*:)`);
}

/** Every module this one takes whole or by its default export, resolved to the tables' spelling. */
function wholeImports(code: string, key: string): { namespace: string[]; byDefault: string[] } {
  const resolved = (pattern: RegExp) =>
    [...code.matchAll(pattern)]
      .map((match) => resolveSpecifier(key, match[1] as string))
      .filter((target): target is string => target !== null);
  return {
    namespace: [
      ...resolved(/(?:import|export)\s*\*\s*as\s+[\w$]+\s+from\s*["']([^"']+)["']/g),
      ...resolved(/(?<!typeof\s*)\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ],
    byDefault: [
      ...resolved(/\bimport\s+(?!type\b)[\w$]+\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+)\s*)?from\s*["']([^"']+)["']/g),
      ...resolved(/\{[^}]*(?<![\w$])default\s+as\s+[\w$]+[^}]*\}\s*from\s*["']([^"']+)["']/g),
    ],
  };
}

/** The modules that carry: whole (a raw loader or an unsealed carrier among their exports), and by default. */
interface Carrying {
  modules: readonly string[];
  defaults: readonly string[];
}

/**
 * Whether a module takes a module that composes whole: a namespace import or re-export, or an `import()`, of a
 * module defining a raw loader or exporting a carrier that is not sealed — where the call that follows is a
 * member read by shape (`import * as add from "./add"` then `add.targetWorker(…)`). Or a default import, by any
 * local name, of a module whose default export carries.
 */
function takesWhole(code: string, key: string, carrying?: Carrying): boolean {
  const { modules, defaults } = carrying ?? { ...carriers(), modules: [...LOADER_MODULES, ...carriers().modules] };
  const { namespace, byDefault } = wholeImports(code, key);
  return namespace.some((target) => modules.includes(target)) || byDefault.some((target) => defaults.includes(target));
}

/**
 * The names a module binds, at its imports, to something that carries under another name: a carrier renamed
 * (`{ resolveWorkers as every }`), a default import of a module whose default carries, and a namespace import
 * of a module that carries. A name that is the carrier's own is matched already.
 */
function importedAliases(
  code: string,
  key: string,
  carrying: Carrying,
  carriedBy: (module: string) => string[],
): string[] {
  const aliases: string[] = [];
  const named = (list: string, target: string) => {
    for (const specifier of list.split(",")) {
      const parts = /^\s*(type\s+)?([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(specifier);
      if (parts === null || parts[1] !== undefined) continue;
      const name = parts[2] as string;
      if (name === "default" ? carrying.defaults.includes(target) : carriedBy(target).includes(name)) {
        aliases.push(parts[3] as string);
      }
    }
  };
  const imports =
    /\bimport\s+(?!type\b)(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?\s*from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(imports)) {
    const target = resolveSpecifier(key, match[4] as string);
    if (target === null) continue;
    if (match[1] !== undefined && carrying.defaults.includes(target)) aliases.push(match[1]);
    if (match[2] !== undefined) named(match[2], target);
    if (match[3] !== undefined && carrying.modules.includes(target)) aliases.push(match[3]);
  }
  return aliases;
}

/**
 * Whether a module composes Workers through a raw loader, by any of the spellings above. `key` is the module's
 * own path, which its relative specifiers are resolved against.
 */
function composesRaw(code: string, key: string): boolean {
  return rawLoaderPattern().test(code) || takesWhole(code, key);
}

/** A module that assembles a backend: a call to `createBackend`, or an import of it under any alias. */
const ASSEMBLES_BACKEND = /\bcreateBackend\s*\(|import\s*(?:type\s+)?\{[^}]*\bcreateBackend\b[^}]*\}\s*from/;

/** An `import()` whose specifier is not a plain string literal — a path, a URL, a template. */
const COMPUTED_IMPORT = /\bimport\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)/;

/**
 * A module that can write this process's environment: an assignment or `delete` on `process.env`, an
 * `Object.assign`/`Reflect` onto it, or `process.env` bound to a name or handed to a function — after
 * which any write is through a name this file cannot follow, so the binding itself counts.
 */
const WRITES_PROCESS_ENV =
  /process\.env\s*(?:\[[^\]]*\]|\.\w+)\s*=(?!=)|\bdelete\s+process\.env\b|\b(?:Object\.assign|Reflect\.set|Reflect\.deleteProperty|Object\.defineProperty)\s*\(\s*process\.env\b|=\s*process\.env\s*[;,)]|\(\s*process\.env\s*[,)]|=\s*(?:globalThis\.)?process\s*;/;

/** The composition environment variable, by its constant or by its own name. */
const NAMES_ENVIRONMENT = /\bENVIRONMENT(?:_VAR)?\b/;

/**
 * Every module that composes Workers with no environment stamped, and **why that composition is not for
 * one environment**. A reason that is no longer true is a hole; each is one sentence a reviewer can check.
 */
const RAW_COMPOSERS: Readonly<Record<string, string>> = {
  "project/config.ts": "Defines loadWorkerConfig, which the primitive's loader spends.",
  "project/workerScope.ts": "Defines the Worker resolvers, which the primitive hands its loader to.",
  "audit/cliAudit.ts":
    "Decides whether a command that names no one environment audits from the composition for none; a command that names its environment in actedOn composes for it through projectCapabilitySetFor.",
  "capabilities/secretApplicability.ts":
    "Resolves once, unstamped, only to learn which Worker directories exist; every environment's answer is composed through composeFor.",
  "capabilities/storeEntryCensus.ts":
    "Resolves once, unstamped, only to read the token profiles each capability declares; a profile's secret name and scope are one project-wide declaration, and the store entries composed from them carry the environment as a segment rather than reading one from a composition.",
  "capabilities/turnstileSitekeys.ts":
    "Reads back the one sitekeys map a pithy.config.ts holds for every environment, composed once for none after writing it; a config that computes a sitekey from its environment is checked for none, which is a limit of this entry.",
  "commands/email.ts":
    "Reads the capability's config and the domains declaration once, unstamped, for provisioning that spans every declared environment; it is not on doctor's per-environment path, and a config that varies its domains by environment is read as whichever composition the module cache holds, which is a limit of this entry.",
  "commands/media.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/payments.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/secrets.ts":
    "Merges the secret registry, which is per project with one value per name; which names each environment reaches is secretApplicability's.",
  "commands/storage.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/support.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/testers.ts":
    "Reads the capability's config as one project-wide declaration, for its roster subcommands too; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/turnstile.ts":
    "Reads the widget set as one project-wide declaration, and the production address from the domains declaration, both unstamped; it is not on doctor's per-environment path, and a config that varies its domains by environment is read as whichever composition the module cache holds, which is a limit of this entry.",
  "commands/vector.ts":
    "Reads the capability's config as one project-wide declaration, for its per-environment subcommands too; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "devSecrets/targets.ts":
    "Reads the dev secrets registry, which is per project with one value per name, re-importing a config pithy add has just written.",
  "main.ts":
    "Imports every command module whole, commands/email.ts among them, to run its default export; each command it runs is held on its own.",
  "project/capabilityWorker.ts":
    "Resolves the one Worker a capability command writes into, for provisioning that spans every declared environment; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "project/deploy.ts":
    "Reads the domains declaration from a composition for no environment, and is not on doctor's per-environment path; a config that varies its domains by environment is read as whichever composition the module cache holds, which is a limit of this entry.",
  "project/deployKit.ts":
    "Reads the domains declaration from a composition for no environment, and is not on doctor's per-environment path; a config that varies its domains by environment is read as whichever composition the module cache holds, which is a limit of this entry.",
  "project/envInventory.ts":
    "Reads the domains declaration from a composition for no environment, and is not on doctor's per-environment path; a config that varies its domains by environment is read as whichever composition the module cache holds, which is a limit of this entry.",
};

/**
 * Every carrier whose composition never leaves it, and **what it hands back instead**. Its callers inherit no
 * composition, so they are not held for calling it. One sentence each, checkable against the function.
 */
const SEALED: Readonly<Record<string, string>> = {
  "audit/cliAudit.ts#createProjectCliAudit":
    "Returns an audit emitter; the composition only decides whether one writes, and is the environment actedOn names when a command names one.",
  "commands/email.ts#default":
    "Returns the pithy email command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/media.ts#default":
    "Returns the pithy media command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/payments.ts#default":
    "Returns the pithy payments command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/secrets.ts#default":
    "Returns the pithy secrets command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/storage.ts#default":
    "Returns the pithy storage command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/support.ts#default":
    "Returns the pithy support command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/testers.ts#default":
    "Returns the pithy testers command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/turnstile.ts#default":
    "Returns the pithy turnstile command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "commands/turnstile.ts#featureSitekeyNote":
    "Returns the sentence `provision` prints about a branch build, read off a turnstile config the caller already holds; no composition of its own and none leaves it.",
  "commands/vector.ts#default":
    "Returns the pithy vector command, which main.ts runs; the composition its run takes is the one this module's RAW_COMPOSERS entry names.",
  "capabilities/secretApplicability.ts#projectSecretApplicability":
    "Returns which secrets each environment reaches, each composed through composeFor; the raw resolve only finds the Worker directories.",
  "capabilities/storeEntryCensus.ts#projectTokenStoreEntries":
    "Returns the Secrets Store entry names the project's token profiles write to, as strings, or null when they cannot be resolved; no composition leaves it.",
  "capabilities/turnstileSitekeys.ts#assertTurnstileSitekeysWritable":
    "Returns nothing; it refuses when the sitekeys map cannot be written.",
  "capabilities/turnstileSitekeys.ts#writeTurnstileSitekeys":
    "Returns the path of the pithy.config.ts written and whether a byte changed.",
  "devSecrets/targets.ts#resolveDevSecretsTargets":
    "Returns each Worker's directory and secret registry, which is per project with one value per name.",
  "main.ts#COMMAND_REGISTRY":
    "Returns the table of commands, each loaded by import() when run; each command it loads is held on its own.",
  "main.ts#main":
    "Returns the root pithy command, which loads a subcommand by import() when run; each command it loads is held on its own.",
  "project/deploy.ts#deployProject":
    "Returns the deploy report; the composition is read only for the domains declaration, unstamped, and a config that varies its domains by environment is read as whichever composition the module cache holds.",
  "project/deployKit.ts#deployKitWorkers":
    "Returns the kit deploy report; the composition is read only for the domains declaration, unstamped, and a config that varies its domains by environment is read as whichever composition the module cache holds.",
  "project/envInventory.ts#buildEnvInventory":
    "Returns the environment inventory; the composition is read only for the domains declaration, unstamped, and a config that varies its domains by environment is read as whichever composition the module cache holds.",
};

/**
 * Every carrier that hands a composition back, and **why that composition is not for one environment**. Each
 * is a raw loader for the rest of the tree: a module naming it is held to {@link RAW_COMPOSERS}.
 */
const CARRYING: Readonly<Record<string, string>> = {
  "commands/email.ts#loadEmailCapability":
    "Returns the email capability instance for pithy email's provisioning, which spans every declared environment; only commands/email.ts calls it.",
  "commands/turnstile.ts#resolveTurnstileTarget":
    "Returns the resolved Worker and its turnstile config for pithy turnstile provision and deprovision, which write every environment's sitekeys at once; only commands/turnstile.ts calls it.",
  "project/capabilityWorker.ts#resolveCapabilityWorker":
    "Returns the resolved Worker and its capability instance for a capability's provisioning, which spans every declared environment; commands/media.ts, payments.ts, storage.ts, support.ts, turnstile.ts and vector.ts call it, each named in RAW_COMPOSERS.",
};

/** Every module that imports a computed specifier, and what it imports. */
const COMPUTED_IMPORTS: Readonly<Record<string, string>> = {
  "project/config.ts": "Imports a Worker's pithy.config.ts, from the cache or as a fresh copy.",
  "project/kitResolve.ts": "Imports a kit package resolved from the adopter's project, never a config.",
  "devSecrets/targets.ts": "Re-imports a config past the module cache; listed in RAW_COMPOSERS with why.",
  "ci/distTypes.ts": "Imports this repository's own built modules to read their exports, never a config.",
};

/** One module's path as the tables spell it — relative to `packages/cli/src`, forward slashes. */
function named(path: string): string {
  return relative(CLI_SRC, path).split("\\").join("/");
}

/** Every shipped CLI module, with its comments blanked out. */
const MODULES: { key: string; code: string }[] = sourceFiles(CLI_SRC).map((file) => ({
  key: named(file.path),
  code: blankComments(file.text),
}));

/** The keys of the modules a pattern matches, sorted. */
function matching(pattern: RegExp): string[] {
  return MODULES.filter((module) => pattern.test(module.code))
    .map((module) => module.key)
    .sort();
}

describe("a composition for an environment is composed for it, by one primitive", () => {
  test("the walk finds the CLI's sources, so a miss is a failure and not a silent pass", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(235);
    const keys = new Set(MODULES.map((module) => module.key));
    for (const key of [PRIMITIVE, ...Object.keys(RAW_COMPOSERS), ...Object.keys(COMPUTED_IMPORTS)]) {
      expect(keys.has(key), `${key} is not in the tree`).toBe(true);
    }
  });

  test("ENVIRONMENT is written into this process by the primitive alone", () => {
    const stampers = MODULES.filter(
      (module) => WRITES_PROCESS_ENV.test(module.code) && NAMES_ENVIRONMENT.test(module.code),
    ).map((module) => module.key);
    expect(
      stampers,
      "This module sets ENVIRONMENT for a composition itself. Compose through composeFor (or composeForSync) in project/composeFor.ts instead: it stamps, restores, queues, and loads each config as evaluated for that environment.",
    ).toEqual([PRIMITIVE]);
  });

  test("the raw loaders are derived from the modules that define them, and include every one planted against", () => {
    expect(
      rawLoaders(),
      "The loaders derived from project/config.ts and project/workerScope.ts changed. A new one is held by this gate already; confirm it composes Workers, and that a removed one no longer does.",
    ).toEqual([
      "loadWorkerConfig",
      "projectCapabilitySet",
      "resolveSingleWorker",
      "resolveWorkerSet",
      "resolveWorkers",
      "resolveWorkersReporting",
    ]);
  });

  test("every carrier out of a module is named, sealed or carrying, with why", () => {
    const { keys } = carriers();
    expect(
      keys,
      "This exported function composes Workers with no environment stamped and hands something back. If its command is about one environment, compose through project/composeFor.ts. If it hands back an answer and never a composition, name it in SEALED with what it returns. If it hands back a composition, name it in CARRYING with why that composition is not for one environment: every module calling it is then held to RAW_COMPOSERS.",
    ).toEqual([...Object.keys(SEALED), ...Object.keys(CARRYING)].sort());
    for (const key of Object.keys(SEALED)) expect(key in CARRYING, key).toBe(false);
    for (const [key, reason] of [...Object.entries(SEALED), ...Object.entries(CARRYING)]) {
      expect(reason, key).toMatch(/^[A-Z].*\.$/);
    }
  });

  test("every module composing Workers without the primitive is named, with why", () => {
    const composers = MODULES.filter((module) => module.key !== PRIMITIVE && composesRaw(module.code, module.key))
      .map((module) => module.key)
      .sort();
    expect(
      composers,
      "This module composes Workers with no environment stamped. If the command is about one environment, compose through project/composeFor.ts (resolveWorkersFor, resolveSingleWorkerFor, composeFor). If it is not, name it in RAW_COMPOSERS with the sentence that says why.",
    ).toEqual(Object.keys(RAW_COMPOSERS).sort());
    for (const [key, reason] of Object.entries(RAW_COMPOSERS)) expect(reason, key).toMatch(/^[A-Z].*\.$/);
  });

  test("every module assembling a backend does it inside the primitive", () => {
    const assemblers = matching(ASSEMBLES_BACKEND);
    expect(assemblers.length, "no module assembles a backend, so this half checks nothing").toBeGreaterThan(0);
    for (const key of assemblers) {
      const code = MODULES.find((module) => module.key === key)?.code ?? "";
      expect(
        PRIMITIVE_EXPORTS.test(code),
        `${key} assembles a backend without composeForSync or composeFor, so a capability's registration-time environment gate reads whatever this process happens to have`,
      ).toBe(true);
    }
  });

  test("every module importing a computed specifier is named, with what it imports", () => {
    expect(
      matching(COMPUTED_IMPORT),
      "This module imports a computed specifier. If it can reach a pithy.config.ts, load it through project/composeFor.ts; either way, name it in COMPUTED_IMPORTS with what it imports.",
    ).toEqual(Object.keys(COMPUTED_IMPORTS).sort());
  });

  test("the extractors see the spellings they claim, and miss the ones the docblock names", () => {
    // Loaders: the call, the import, an alias, and the shorthand — and not a seam's key or member.
    expect(rawLoaderPattern().test("const workers = await resolveWorkers({ projectDir });")).toBe(true);
    expect(rawLoaderPattern().test('import { resolveWorkers as every } from "../project/workerScope";')).toBe(true);
    expect(rawLoaderPattern().test("const seams = { loadWorkerConfig };")).toBe(true);
    expect(rawLoaderPattern().test("const found = await resolveSingleWorker(options);")).toBe(true);
    expect(rawLoaderPattern().test("resolveWorkers?: (options: { projectDir: string }) => Promise<W[]>;")).toBe(false);
    expect(rawLoaderPattern().test("const resolve = options.resolveWorkers ?? fallback;")).toBe(false);
    expect(rawLoaderPattern().test("const workers = await resolveWorkersFor(env, { projectDir });")).toBe(false);
    // The two loaders the typed list missed, and their twins through the primitive.
    expect(rawLoaderPattern().test("const workerSet = await resolveWorkerSet({ projectDir });")).toBe(true);
    expect(rawLoaderPattern().test('import { projectCapabilitySet as union } from "../project/workerScope";')).toBe(
      true,
    );
    expect(rawLoaderPattern().test("await projectCapabilitySetFor(env, projectDir)")).toBe(false);
    // A pure fold over Workers already composed is not a loader.
    expect(rawLoaderPattern().test("const union = projectCapabilities(workers);")).toBe(false);
    // The derivation reads every declaration shape, exported or not, and every way a name leaves a module.
    const shape = moduleShape(
      [
        "const helper = (dir) => loadWorkerConfig(dir);",
        "export async function viaHelper(dir) {",
        "  const banner = `",
        "export default nothing;",
        "`;",
        "  return helper(dir);",
        "}",
        "export const arrow = async (dir) => {",
        "  return 1;",
        "};",
        "const TICK = /\\`[\"']/;",
        "let assigned;",
        "assigned = async (dir) => loadWorkerConfig(dir);",
        "class Loader {",
        "  static load(dir) { return loadWorkerConfig(dir); }",
        "}",
        "export default async function (dir) { return helper(dir); }",
        "export {",
        "  assigned,",
        "  Loader as WorkerLoader,",
        "  type Hidden,",
        "  helper as default,",
        "};",
        'export { resolveWorkers as every, default as composed } from "./workerScope";',
        'export * from "./config";',
        'export * as scope from "./workerScope";',
        "export const { load: loadOne, other = 1, ...rest } = loaders;",
      ].join("\n"),
    );
    expect(shape.declarations.map(({ name }) => name)).toEqual([
      "helper",
      "viaHelper",
      "arrow",
      "TICK",
      "assigned",
      "assigned",
      "Loader",
      "default",
      "loadOne",
      "other",
      "rest",
    ]);
    expect(Object.fromEntries(shape.exports)).toEqual({
      viaHelper: ["viaHelper"],
      arrow: ["arrow"],
      default: ["default"],
      assigned: ["assigned"],
      Loader: ["WorkerLoader"],
      helper: ["default"],
      loadOne: ["loadOne"],
      other: ["other"],
      rest: ["rest"],
    });
    expect(shape.reexports).toEqual([
      { name: "resolveWorkers", exported: "every", from: "./workerScope" },
      { name: "default", exported: "composed", from: "./workerScope" },
    ]);
    expect(shape.stars).toEqual([
      { from: "./config", as: null },
      { from: "./workerScope", as: "scope" },
    ]);
    // Specifiers resolve against the module that wrote them, with or without an extension.
    expect(resolveSpecifier("commands/migrate.ts", "../project/envInventory.js")).toBe("project/envInventory.ts");
    expect(resolveSpecifier("commands/migrate.ts", "@pithy-sh/cli/src/commands/email")).toBe("commands/email.ts");
    expect(resolveSpecifier("commands/migrate.ts", "@pithy-sh/testers/src/config/config")).toBe(null);
    // A directory is its index, as the bundler resolves it; a module beside it of the same name wins.
    const tree = ["project/zzplantdir/index.ts", "commands/migrate.ts"];
    expect(resolveSpecifier("commands/migrate.ts", "../project/zzplantdir", tree)).toBe("project/zzplantdir/index.ts");
    expect(resolveSpecifier("commands/migrate.ts", "../project/zzplantdir/", tree)).toBe("project/zzplantdir/index.ts");
    expect(resolveSpecifier("commands/migrate.ts", "../project/zzplantdir", [...tree, "project/zzplantdir.ts"])).toBe(
      "project/zzplantdir.ts",
    );
    // An identifier with a `$` in it is an identifier, not an anchor, wherever a name enters a RegExp.
    expect(namesAny(["zzLoad$"]).test("return zzLoad$(dir);")).toBe(true);
    expect(namesAny(["zzLoad$"]).test("return zzLoad$x(dir);")).toBe(false);
    expect(namesAny(["zz.Load"]).test("return zzxLoad(dir);")).toBe(false);
    expect(
      rawLocals([
        { name: "zzLoad$", text: "export const zzLoad$ = async (dir) => loadWorkerConfig(dir);" },
        { name: "zzUse", text: "export const zzUse = (dir) => zzLoad$(dir);" },
      ]),
    ).toEqual(new Set(["loadWorkerConfig", "zzLoad$", "zzUse"]));
    expect(
      wholeImports(
        [
          'import compose, { other } from "./a";',
          'import { default as named } from "../b";',
          'import type Typed from "./c";',
          'import * as d from "./d";',
          'export * as e from "./e";',
          'const f = await import("./f");',
          'type G = typeof import("./g");',
        ].join("\n"),
        "commands/x.ts",
      ),
    ).toEqual({
      namespace: ["commands/d.ts", "commands/e.ts", "commands/f.ts"],
      byDefault: ["commands/a.ts", "b.ts"],
    });
    // A type query names a loader's shape and composes nothing.
    expect(rawLoaderPattern().test("workers: Awaited<ReturnType<typeof resolveWorkers>>,")).toBe(false);
    expect(namesAny(["resolveWorkers"]).test("typeof   resolveWorkers")).toBe(false);
    // A carrier is a loader for everyone else: the one carrying today, and the one it replaced.
    expect(rawLoaderPattern().test("const email = await loadEmailCapability(projectDir);")).toBe(true);
    expect(rawLoaderPattern().test("const target = await targetWorker(env, options);")).toBe(false);
    // A sealed carrier is not.
    expect(rawLoaderPattern().test("const inventory = await buildEnvInventory(options);")).toBe(false);
    // A namespace import of a module exporting a carrier, where the call is a member read by shape.
    expect(composesRaw('import * as email from "./email";', "commands/x.ts")).toBe(true);
    expect(composesRaw('import * as email from "./email.js";', "commands/x.ts")).toBe(true);
    expect(
      composesRaw('const { loadEmailCapability: load } = await import("../commands/email");', "project/x.ts"),
    ).toBe(true);
    expect(composesRaw('import * as domains from "../project/domains";', "commands/x.ts")).toBe(false);
    // The two shapes the skips let through, and what catches them instead.
    expect(rawLoaderPattern().test('const { resolveWorkers: all } = await import("./workerScope");')).toBe(false);
    expect(composesRaw('const { resolveWorkers: all } = await import("./workerScope");', "project/x.ts")).toBe(true);
    expect(composesRaw('import * as scope from "../project/workerScope";', "commands/x.ts")).toBe(true);
    expect(composesRaw('export * as scope from "./workerScope";', "project/x.ts")).toBe(true);
    expect(composesRaw('import * as config from "./config";', "project/x.ts")).toBe(true);
    // Resolved, not matched by the last segment: a package's own `config` is not this CLI's.
    expect(composesRaw('type C = typeof import("@pithy-sh/testers/src/config/config");', "project/x.ts")).toBe(false);
    expect(composesRaw('import * as config from "./config";', "commands/x.ts")).toBe(false);
    expect(composesRaw('const { loadProject } = await import("../project/workerIdentity");', "commands/x.ts")).toBe(
      false,
    );
    // Backends.
    expect(ASSEMBLES_BACKEND.test("const app = createBackend({ capabilities });")).toBe(true);
    expect(
      ASSEMBLES_BACKEND.test('import { createBackend as assemble } from "@pithy-sh/core/src/createBackend";'),
    ).toBe(true);
    expect(ASSEMBLES_BACKEND.test("detail: `createBackend refuses to assemble without them.`")).toBe(false);
    // Computed imports.
    expect(COMPUTED_IMPORT.test("await import(pathToFileURL(path).href)")).toBe(true);
    // Assembled, so the placeholder is the text under test rather than a template the linter reads as a slip.
    expect(COMPUTED_IMPORT.test(["await import(`$", "{path}?pithy-reload=$", "{count}`)"].join(""))).toBe(true);
    expect(COMPUTED_IMPORT.test("await import(url)")).toBe(true);
    expect(COMPUTED_IMPORT.test('await import("miniflare")')).toBe(false);
    // Environment writes, in every spelling planted against it.
    expect(WRITES_PROCESS_ENV.test("process.env[ENVIRONMENT_VAR] = environment;")).toBe(true);
    expect(WRITES_PROCESS_ENV.test('process.env.ENVIRONMENT = "prod";')).toBe(true);
    expect(WRITES_PROCESS_ENV.test("delete process.env[ENVIRONMENT_VAR];")).toBe(true);
    expect(WRITES_PROCESS_ENV.test("Object.assign(process.env, { ENVIRONMENT: env });")).toBe(true);
    expect(WRITES_PROCESS_ENV.test('Reflect.set(process.env, "ENVIRONMENT", env);')).toBe(true);
    expect(WRITES_PROCESS_ENV.test("const ambient = process.env;")).toBe(true);
    expect(WRITES_PROCESS_ENV.test("stamp(process.env, name, env);")).toBe(true);
    expect(WRITES_PROCESS_ENV.test("const value = process.env[ENVIRONMENT_VAR];")).toBe(false);
    expect(WRITES_PROCESS_ENV.test("if (process.env.ENVIRONMENT === env) return;")).toBe(false);
    expect(NAMES_ENVIRONMENT.test('ambient["ENVIRONMENT"] = env;')).toBe(true);
    expect(NAMES_ENVIRONMENT.test("import { ENVIRONMENT_VAR as NAME } from 'x';")).toBe(true);
    // The spelling the docblock says it misses, planted rather than asserted about in prose.
    expect(NAMES_ENVIRONMENT.test('process.env[["ENVIRON", "MENT"].join("")] = env;')).toBe(false);
  });
});
