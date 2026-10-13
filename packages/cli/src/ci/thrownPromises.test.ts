// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, resolve, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **What a CLI module throws is an error, never a Promise of one (#697).**
 *
 * `capabilityLoadError` became async when a `not-installed` refusal started naming its `fix`, and three testers
 * loaders kept `throw capabilityLoadError(…)`. Nothing objects to that: TypeScript lets `throw` take any value, and
 * Biome has no rule for it. What reached the funnel was a pending Promise, so the run ended unclassified, printed
 * `Promise { <pending> }`, and carried neither the refusal's sentence nor its `fix`. The classifier was right the
 * whole time, which is why its own tests stayed green.
 *
 * So every promise-returning callable in shipped source is collected by name, and a `throw` of a call to one must
 * be `throw await`. Promise-returning is `async`, or — transitively — a plain function, arrow or method whose
 * returned expression is a call to one: `testersNotComposed` is a plain function returning
 * `capabilityNotComposed(…)`, and throwing it throws the Promise all the same. Two shapes are read: the call thrown directly (`throw build(…)`, `throw this.build(…)`), and the
 * call kept in a binding and thrown on a later line (`const error = build(…); … throw error`). A name declared both
 * async and sync somewhere in the source is checked only where the throwing file does not declare it sync itself.
 * The end-to-end proof for the case that was found is `testersNotInstalled.e2e.test.ts`.
 */

/** The CLI's source root. */
const SRC = resolve(import.meta.dirname, "..");

/** Words a method-shaped match must not read as a name. */
const KEYWORDS = new Set(["function", "if", "for", "while", "switch", "catch", "return", "await"]);

/** `async function name`, `name = async (`, `name: async (`, and an `async name(` method. */
const ASYNC_DECLARATIONS = [
  /\basync\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\b([A-Za-z_$][\w$]*)\s*[:=]\s*async\b/g,
  /^\s*(?:(?:public|private|protected|static|override|readonly)\s+)*async\s+([A-Za-z_$][\w$]*)\s*[<(]/gm,
];

/** `function name` with no `async` before it, and `name = (` or `name = function`. */
const SYNC_DECLARATIONS = [
  /(?<!async\s+)\bfunction\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g,
];

/** One module's text, keyed by its `src`-relative path. */
interface Module {
  readonly path: string;
  readonly code: string;
}

/** Every name the patterns capture in `code`. */
function namesIn(code: string, patterns: readonly RegExp[]): Set<string> {
  const names = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && !KEYWORDS.has(name)) names.add(name);
    }
  }
  return names;
}

/** The promise-returning callables: every name, and the ones each module declares itself. */
interface Promising {
  readonly all: Set<string>;
  readonly byModule: Map<string, Set<string>>;
}

/** Whether `name`, called in `module`, returns a Promise: its own declaration decides, or else anyone's. */
function promisingIn(promising: Promising, module: Module, ownSync: ReadonlySet<string>, name: string): boolean {
  return (promising.byModule.get(module.path)?.has(name) ?? false) || (promising.all.has(name) && !ownSync.has(name));
}

/** The index just past the bracket that closes the one at `open`, skipping string literals. */
function closing(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let index = open; index < code.length; index++) {
    const char = code[index] as string;
    if (char === '"' || char === "'" || char === "`") {
      for (index++; index < code.length && code[index] !== char; index++) if (code[index] === "\\") index++;
    } else if (char in pairs) stack.push(pairs[char] as string);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return code.length;
}

/**
 * Where a function's body starts, given the index just past its parameter list: the `{` of a block, or the first
 * character of an arrow's expression. A return type is skipped, object-literal types included.
 */
function bodyStart(code: string, from: number): number {
  let index = from;
  let previous = "";
  while (index < code.length) {
    const char = code[index] as string;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (code.startsWith("=>", index)) {
      index += 2;
      while (/\s/.test(code[index] ?? "")) index++;
      return index;
    }
    // A `{` right after `:`, `|`, `&`, `<` or `,` is a type literal; any other is the body.
    if (char === "{" && (previous === "" || !":|&<,".includes(previous))) return index;
    if (char === "(" || char === "[" || char === "{") {
      index = closing(code, index);
      previous = ")";
      continue;
    }
    if (char === ";") return index;
    previous = char;
    index++;
  }
  return index;
}

/** `function name(`, `name = (…) =>` / `name = function (`, and a `name(…) {` method, none of them `async`. */
const SYNC_CALLABLES = [
  /(?<!async\s+)\bfunction\s+([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\(/g,
  /\b([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:function\b\s*(?:<[^>()]*>)?)?(?:<[^>()]*>)?\(/g,
  /\b([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([A-Za-z_$][\w$]*)\s*=>/g,
  /^\s*(?:(?:public|private|protected|static|override|readonly)\s+)*(?!async\b)([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\(/gm,
];

/** A call's callee name at the start of `text` — `build(`, `this.build(`, `factory.build<T>(` — or `undefined`. */
function calleeAt(text: string): string | undefined {
  return /^\(?\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\(/.exec(text)?.[1];
}

/** `body` with every nested function's block blanked, so a callback's `return` is not read as the function's own. */
function withoutNestedBodies(body: string): string {
  let out = body;
  for (const match of body.matchAll(/=>\s*\{|\bfunction\b[^{]*\{/g)) {
    const open = match.index + match[0].length - 1;
    if (open === 0) continue;
    const end = closing(body, open);
    out = out.slice(0, open + 1) + " ".repeat(Math.max(0, end - open - 2)) + out.slice(end - 1);
  }
  return out;
}

/** Each non-`async` callable in `code`, with the callees of every expression it returns. */
function syncCallables(code: string): { name: string; returns: string[] }[] {
  const found: { name: string; returns: string[] }[] = [];
  for (const pattern of SYNC_CALLABLES) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1] as string;
      if (KEYWORDS.has(name)) continue;
      // An arrow with one bare parameter has no list to skip; every other shape ends its match on the `(`.
      const afterParams =
        match[2] !== undefined ? match.index + match[0].length - 2 : closing(code, match.index + match[0].length - 1);
      const start = bodyStart(code, afterParams);
      if (code[start] !== "{") {
        // Only an arrow has an expression body; anything else that got here is a call, not a declaration.
        if (!code.slice(afterParams, start).includes("=>")) continue;
        const callee = calleeAt(code.slice(start));
        found.push({ name, returns: callee === undefined ? [] : [callee] });
        continue;
      }
      const body = withoutNestedBodies(code.slice(start, closing(code, start)));
      const returns: string[] = [];
      for (const ret of body.matchAll(/\breturn\s+/g)) {
        const callee = calleeAt(body.slice(ret.index + ret[0].length));
        if (callee !== undefined && callee !== "new") returns.push(callee);
      }
      found.push({ name, returns });
    }
  }
  return found;
}

/**
 * The promise-returning callables in `modules`: every `async` one, then, until nothing changes, every plain one
 * whose returned expression is a call to one of those.
 */
function promisingNames(modules: readonly Module[]): Promising {
  const promising: Promising = { all: new Set(), byModule: new Map() };
  const scanned = modules.map((module) => ({
    module,
    ownSync: namesIn(module.code, SYNC_DECLARATIONS),
    callables: syncCallables(module.code),
  }));
  for (const module of modules) {
    const own = namesIn(module.code, ASYNC_DECLARATIONS);
    promising.byModule.set(module.path, own);
    for (const name of own) promising.all.add(name);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const { module, ownSync, callables } of scanned) {
      const own = promising.byModule.get(module.path) as Set<string>;
      for (const { name, returns } of callables) {
        if (own.has(name) || !returns.some((callee) => promisingIn(promising, module, ownSync, callee))) continue;
        own.add(name);
        promising.all.add(name);
        grew = true;
      }
    }
  }
  return promising;
}

/** Each `throw` of an un-awaited call to a promise-returning callable, as `path: line`. */
function thrownPromises(modules: readonly Module[], promising: Promising): string[] {
  const found: string[] = [];
  for (const module of modules) {
    const { path, code } = module;
    const ownSync = namesIn(code, SYNC_DECLARATIONS);
    const isAsync = (name: string) => promisingIn(promising, module, ownSync, name);
    const lineOf = (index: number) => code.slice(0, index).split("\n").length;

    // `throw build(…)`, `throw this.build(…)`, `throw factory.build(…)` — the call itself, not awaited.
    for (const match of code.matchAll(
      /\bthrow\s+((?:[A-Za-z_$][\w$]*\s*\.\s*)*)([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\(/g,
    )) {
      const name = match[2] as string;
      if (name !== "await" && isAsync(name)) found.push(`${path}:${lineOf(match.index)} throw ${match[1]}${name}(`);
    }

    // `const error = build(…)`, then `throw error` — the same Promise, thrown a line later.
    for (const match of code.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\(/g,
    )) {
      const [, binding, name] = match as unknown as [string, string, string];
      if (!isAsync(name)) continue;
      const after = code.slice(match.index);
      if (new RegExp(`\\bthrow\\s+${binding.replace(/\$/g, "\\$")}\\b`).test(after)) {
        found.push(`${path}:${lineOf(match.index)} ${binding} = ${name}( … throw ${binding}`);
      }
    }
  }
  return found;
}

/** Every shipped module under `src`, comments blanked. */
function shippedModules(): Module[] {
  return sourcePaths(SRC).map((path) => ({
    path: relative(SRC, path).split(sep).join("/"),
    code: blankComments(readSource(path) ?? ""),
  }));
}

describe("a thrown error is never a Promise", () => {
  const modules = shippedModules();
  const promising = promisingNames(modules);

  test("no shipped module throws an un-awaited call to a promise-returning callable", () => {
    expect(thrownPromises(modules, promising)).toEqual([]);
  });

  test("the scan sees the builders this rule exists for, and the sites that await them", () => {
    expect(modules.length).toBeGreaterThan(300);
    expect(promising.all).toContain("capabilityLoadError");
    // `capabilityNotComposed` reads the project synchronously since #711, so it builds an error rather than a
    // Promise — and the scan, which reads declarations rather than a list, no longer counts it or its wrappers.
    expect(promising.all).not.toContain("capabilityNotComposed");
    expect(promising.byModule.get("commands/testers.ts") ?? []).not.toContain("testersNotComposed");
    const awaited = modules.reduce((sum, module) => sum + (module.code.match(/\bthrow\s+await\b/g)?.length ?? 0), 0);
    // A floor, not a count: four `throw await capabilityNotComposed(…)` became plain throws when it went sync (#711).
    expect(awaited).toBeGreaterThan(15);
  });

  describe("a planted defect is caught", () => {
    const builder: Module = {
      path: "builder.ts",
      code: "export async function capabilityLoadError() { return new Error(); }",
    };
    const asyncOf = (...more: Module[]) => promisingNames([builder, ...more]);

    test.each([
      ["thrown directly", "throw capabilityLoadError(1, 2);"],
      ["thrown with a type argument", "throw capabilityLoadError<E>(1);"],
      ["thrown off a member", "throw loaders.capabilityLoadError(1);"],
      ["kept in a binding and thrown later", "const error = capabilityLoadError(1);\nlog();\nthrow error;"],
    ])("%s", (_shape, code) => {
      const site: Module = { path: "site.ts", code };
      expect(thrownPromises([builder, site], asyncOf(site))).toHaveLength(1);
    });

    test.each([
      ["awaited", "throw await capabilityLoadError(1, 2);"],
      ["awaited into a binding", "const error = await capabilityLoadError(1);\nthrow error;"],
      [
        "a sync builder of the same name in the throwing file",
        "function capabilityLoadError() {}\nthrow capabilityLoadError();",
      ],
      ["a constructor", "throw new capabilityLoadError();"],
    ])("but not when %s", (_shape, code) => {
      const site: Module = { path: "site.ts", code };
      expect(thrownPromises([builder, site], asyncOf(site))).toEqual([]);
    });

    /**
     * **A wrapper that is not `async` returns the Promise all the same (#697 review).** `testers.ts`'s
     * `testersNotComposed` is a plain function returning `capabilityNotComposed(…)`; a `throw testersNotComposed(…)`
     * throws a Promise exactly as `throw capabilityNotComposed(…)` would, and a scan of `async` declarations
     * alone never saw it.
     */
    test.each([
      [
        "a plain function returning the builder's call, thrown in its own file",
        "function notComposed(dir: string, workers: readonly { dir: string }[]): Promise<Error> {\n  return capabilityLoadError(dir, workers.map((w) => w.dir));\n}\nthrow notComposed(a, b);",
      ],
      [
        "an arrow returning it",
        "const notComposed = (dir: string) => capabilityLoadError(dir);\nthrow notComposed(a);",
      ],
      [
        "a wrapper of a wrapper",
        "function inner() {\n  return capabilityLoadError();\n}\nfunction outer() {\n  return inner();\n}\nconst error = outer();\nthrow error;",
      ],
      [
        "a method returning it",
        "class A {\n  refusal(x: number) {\n    return this.capabilityLoadError(x);\n  }\n}\nthrow a.refusal(1);",
      ],
    ])("a non-async wrapper: %s", (_shape, code) => {
      const site: Module = { path: "site.ts", code };
      expect(thrownPromises([builder, site], asyncOf(site))).toHaveLength(1);
    });

    test("a non-async wrapper declared in one file and thrown in another", () => {
      const wrapper: Module = {
        path: "wrapper.ts",
        code: "export function notComposed() {\n  return capabilityLoadError();\n}",
      };
      const site: Module = { path: "site.ts", code: "throw notComposed();" };
      expect(thrownPromises([builder, wrapper, site], asyncOf(wrapper, site))).toHaveLength(1);
    });

    test.each([
      ["it returns something else", "function notComposed() {\n  return new Error();\n}\nthrow notComposed();"],
      [
        "only a callback inside it returns the call",
        "function notComposed() {\n  const later = () => {\n    return capabilityLoadError();\n  };\n  return new Error(String(later));\n}\nthrow notComposed();",
      ],
      [
        "it is thrown awaited",
        "function notComposed() {\n  return capabilityLoadError();\n}\nthrow await notComposed();",
      ],
    ])("but not a wrapper when %s", (_shape, code) => {
      const site: Module = { path: "site.ts", code };
      expect(thrownPromises([builder, site], asyncOf(site))).toEqual([]);
    });

    test("an async method and an arrow are collected too", () => {
      const { all: names } = promisingNames([
        { path: "a.ts", code: "class A {\n  async build(x: number) {}\n  private async other<T>() {}\n}" },
        { path: "b.ts", code: "const make = async () => 1;\nconst o = { built: async () => 2 };" },
      ]);
      expect([...names].sort()).toEqual(["build", "built", "make", "other"]);
    });
  });
});
