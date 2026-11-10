// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { causeMessage, prop, safeReason } from "@pithy-sh/core/src/error/cause";

/**
 * Reading the error Node throws when a module will not compile as the CLI imports it, which is through type
 * stripping. Node names the file and line only in the head of the stack, never in the message, so a refusal that
 * quotes the message alone cannot say which of the config's imports broke it.
 */

/** Where Node says a module failed to compile: the file it heads the stack with, and the line. */
export interface CompileSite {
  /** The module's absolute path. */
  file: string;
  /** 1-based line. */
  line: number;
}

/**
 * The file and line Node heads a compile error's stack with (`/abs/path.ts:4`, or a `file:` URL), or `undefined`
 * when the stack starts any other way: a message, a relative location, a `node:` internal.
 */
export function compileSite(cause: unknown): CompileSite | undefined {
  const stack = prop(cause, "stack");
  if (typeof stack !== "string") return undefined;
  const head = /^(.+):(\d+)$/.exec(stack.split("\n")[0] ?? "");
  if (!head?.[1] || !head[2]) return undefined;
  const location = head[1];
  const file = location.startsWith("file:") ? fileURLToPath(location) : location;
  if (!isAbsolute(file)) return undefined;
  return { file, line: Number(head[2]) };
}

/** What type stripping refused, in words an adopter recognizes, and the rewrite that strips. */
export interface StripOnlySyntax {
  /** The construct, as a noun phrase: `a TypeScript enum`. */
  construct: string;
  /** One sentence: what to write instead. */
  rewrite: string;
}

/** Node's wording for each construct it refuses, and what this module says about it. */
const REFUSED: readonly { said: RegExp; syntax: StripOnlySyntax }[] = [
  {
    said: /^TypeScript parameter property is not supported/,
    syntax: {
      construct: "a TypeScript parameter property",
      rewrite: "Declare the field in the class and assign it in the constructor.",
    },
  },
  {
    said: /^TypeScript enum is not supported/,
    syntax: { construct: "a TypeScript enum", rewrite: "Use an object `as const` and a union of its values." },
  },
  {
    said: /^TypeScript namespace declaration is not supported/,
    syntax: { construct: "a TypeScript namespace", rewrite: "Export its members from the module itself." },
  },
  {
    said: /^TypeScript import equals declaration is not supported/,
    syntax: { construct: "`import =`", rewrite: "Use an import statement." },
  },
  {
    said: /^TypeScript export assignment is not supported/,
    syntax: { construct: "`export =`", rewrite: "Use `export default`." },
  },
  {
    said: /angle-bracket syntax for type assertions/,
    syntax: { construct: "an angle-bracket type assertion", rewrite: "Write `value as T`." },
  },
];

/** Node's code for TypeScript that type stripping cannot erase. */
const UNSUPPORTED = "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX";

/**
 * The construct type stripping refused, and its rewrite, or `undefined` when the cause is not that refusal. A
 * refusal in words this module does not know is still named as one, with a rewrite that invents nothing.
 */
export function stripOnlySyntax(cause: unknown): StripOnlySyntax | undefined {
  const message = causeMessage(cause) ?? "";
  const known = REFUSED.find(({ said }) => said.test(message));
  if (known !== undefined) return known.syntax;
  if (prop(cause, "code") !== UNSUPPORTED) return undefined;
  return {
    construct: "TypeScript that does not erase",
    rewrite: "Rewrite it so that removing its types leaves JavaScript.",
  };
}

/** How {@link nodeCompileFailure} names a file. */
export interface CompileFailureOptions {
  /** The config's directory. Another file is shown relative to it. */
  relativeTo?: string | undefined;
  /** Whether a file is the config itself, or the copy of it the CLI imported in its place. */
  isConfig?: ((file: string) => boolean) | undefined;
}

/** A Node compile failure, classified: its kind and the `action` line that names the file, the line and the fix. */
export interface CompileFailure {
  kind: "strip-only" | "parse-error";
  action: string;
}

const NO_INSTALL = "installing dependencies will not help.";

/**
 * The refusal for a config whose import Node would not compile, naming the file that broke it, the line, and what
 * to do: the construct and its rewrite for TypeScript type stripping refuses, the parser's reason for a file that
 * does not parse.
 *
 * `undefined` for anything else: a Bun diagnostic, a throw at load, an error with no compile site.
 */
export function nodeCompileFailure(cause: unknown, options: CompileFailureOptions = {}): CompileFailure | undefined {
  const site = compileSite(cause);
  const syntax = stripOnlySyntax(cause);
  if (syntax !== undefined) {
    const where = site === undefined ? "" : ` on line ${site.line}`;
    return {
      kind: "strip-only",
      action: `${subject(site, options, "The config or a module it imports")} uses ${syntax.construct}${where}. Node's type stripping refuses it, and the CLI loads the config that way. ${syntax.rewrite}`,
    };
  }
  if (site === undefined || prop(cause, "name") !== "SyntaxError") return undefined;
  const reason = safeReason(cause);
  const own = options.isConfig?.(site.file) === true;
  return {
    kind: "parse-error",
    action: `${subject(site, options, "The config")} does not parse${reason ? `: ${reason}` : ""}. Line ${site.line}. ${own ? "Fix the file" : "Fix that file"} — ${NO_INSTALL}`,
  };
}

/** The sentence's subject: the config, the imported file by its path from the config, or `unknown` with no site. */
function subject(site: CompileSite | undefined, options: CompileFailureOptions, unknown: string): string {
  if (site === undefined) return unknown;
  if (options.isConfig?.(site.file) === true) return "The config";
  return importedFile(site.file, options.relativeTo);
}

/** A file the config imports, as a sentence's subject: `./src/tar.ts, which the config imports,`. */
export function importedFile(file: string, relativeTo: string | undefined): string {
  return `${shown(file, relativeTo)}, which the config imports,`;
}

/** A path from the config's directory, written the way an import from the config would write it. */
function shown(file: string, relativeTo: string | undefined): string {
  if (relativeTo === undefined) return basename(file);
  const path = relative(relativeTo, file).split("\\").join("/");
  return path.startsWith("../") ? path : `./${path}`;
}
