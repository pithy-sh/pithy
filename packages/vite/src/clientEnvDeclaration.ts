// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * **`client-env.d.ts` is generated from the four declared client projections (#398).**
 *
 * `@pithy-sh/ui-react`'s `templates/client-env.d.ts` is the ambient declaration for the four
 * `virtual:pithy/*` modules, copied into an adopter's Worker by `pithy ui add react`. It used to be
 * hand-written, three packages away from the `client:` projections that produce the values it
 * describes, and #392 held the two together with a spawned compiler because there was no faithful
 * source to generate from: `Capability.client` is typed `(context) => ClientProjection`, so each
 * capability's real shape existed only as an inferred literal inside a closure.
 *
 * #395 removed that. The four capabilities now declare their projection types, and the declaration is
 * the source of truth rather than a restatement of the literal. So there is exactly one statement of
 * each shape, and this module copies it — **a gate that watches two things agree is strictly worse
 * than one thing.**
 *
 * ## Why the declared type is copied as text rather than re-printed from a type
 *
 * Because the doc comments are half of what the file is worth. A declaration emitted from a resolved
 * type carries the shape and loses every sentence attached to it, and those sentences are what tell a
 * screen that `action` must be rendered and never retyped, or that a Paddle client token is
 * publishable by design. Copying the type node's own source text keeps the unions, the `| null` arms
 * and the prose exactly as the capability wrote them.
 *
 * The one thing that is *not* copied is what is not a shape at all — see {@link PREAMBLE} and
 * {@link ENABLED_EXPORT}, both of which are policy and are written as fixed text.
 *
 * ## Nothing an adopter runs
 *
 * The kit generates at its own build time and commits the artifact. `pithy ui add react` still copies
 * a plain static `.d.ts` into a Worker, and a scaffolded project typechecks with no new step.
 */

/** One `virtual:pithy/*` module, and the declared type that is its whole shape. */
export interface DeclaredModule {
  /** The capability name — the segment after `virtual:pithy/`. */
  readonly module: string;
  /** The specifier the projection is read from. Resolved through the package's own exports map. */
  readonly specifier: string;
  /** The exported type alias that declares what a browser receives. */
  readonly type: string;
}

/**
 * The modules the declaration covers, in the order they are emitted.
 *
 * This list is the whole reach of the generated file: a further capability projecting to a browser is
 * a further entry here, and until it is one, nothing declares it. The specifiers resolve because each
 * capability is a devDependency of `@pithy-sh/vite` — a build-time dependency, like the compiler. An
 * adopter installs none of them to use the plugin, and never runs this module.
 */
export const DECLARED_MODULES: readonly DeclaredModule[] = [
  { module: "auth", specifier: "@pithy-sh/auth/src/client/projection", type: "AuthClientProjection" },
  { module: "i18n", specifier: "@pithy-sh/i18n/src/client/projection", type: "I18nClientProjection" },
  { module: "payments", specifier: "@pithy-sh/payments/src/client/projection", type: "PaymentsClientProjection" },
  { module: "support", specifier: "@pithy-sh/support/src/client/projection", type: "SupportClientProjection" },
  { module: "turnstile", specifier: "@pithy-sh/turnstile/src/client/projection", type: "TurnstileClientProjection" },
];

/**
 * **Fixed text, item one: the preamble.**
 *
 * The `vite/client` reference and the paragraph explaining why the default export is a union are
 * policy about how the modules are consumed, not a projection of anything, so there is nothing to
 * derive them from. They are written here.
 */
const PREAMBLE = `/// <reference types="vite/client" />

// The client-safe projection of this worker's composed capabilities, served by @pithy-sh/vite.
//
// Each module is a DEFAULT export whose type is a union discriminated on \`enabled\`. That shape is
// deliberate. A capability that is not composed projects \`{ enabled: false }\` and nothing else, so a
// NAMED import of any other key would be a missing export and the build would fail — on exactly the
// case this mechanism exists to make survivable. Importing the default and narrowing cannot fail:
//
//   import turnstile from "virtual:pithy/turnstile";
//   if (!turnstile.enabled) return null;   // narrowed: sitekey, mode and token exist below this line
//
// The \`virtual:pithy/*\` modules are never written to disk. These declarations describe modules the
// Vite plugin serves, built from the Worker's own pithy.config.ts.
//
// **Generated, and copied here as it was emitted (#398).** Each declaration below is a capability's
// declared client projection — \`src/client/projection.ts\` in @pithy-sh/auth, @pithy-sh/payments,
// @pithy-sh/support and @pithy-sh/turnstile — written out by @pithy-sh/vite's
// \`src/clientEnvDeclaration.ts\` at kit build time. In the kit that is one statement of each shape and
// nothing to keep in step: a field a projection stops emitting is a compile error where it is
// projected, and this file moves in the same commit.
//
// In your repository it is yours, like every other seeded file. Editing it changes what your compiler
// believes and nothing about what the plugin serves.
`;

/**
 * **Fixed text, item two: the one named export.**
 *
 * `enabled` is declared alone on purpose, and the refusal is the feature. A capability nobody composed
 * serves `{ enabled: false }` and nothing else, so `import { sitekey } from "virtual:pithy/turnstile"`
 * has to fail the build — on exactly the case the union exists to make survivable. Deriving the named
 * exports from the projection's keys would declare every one of them and take that refusal away.
 */
const ENABLED_EXPORT = `  /**
   * Whether this capability is composed and serving on this worker. Also the union's discriminant.
   *
   * The only named export, deliberately. Every other key is reached through the default export and a
   * narrowing — see the note at the top of this file.
   */
  export const enabled: boolean;
`;

/**
 * Which characters of a TypeScript source are code — everything outside a comment or a string.
 *
 * Both passes below need it, and for the same reason: a brace in `` `POST {basePath}/feedback` `` and
 * a type name in an `{@link …}` tag are text, and counting or rewriting them would be a silent wrong
 * answer rather than an error. Template literals with `${}` substitutions are not handled, because a
 * type position cannot hold one — `parseTypeAliases` refuses anything it cannot finish instead.
 */
function codeMask(source: string): boolean[] {
  const mask: boolean[] = new Array<boolean>(source.length).fill(true);
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") mask[index++] = false;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const stop = close === -1 ? source.length : close + 2;
      while (index < stop) mask[index++] = false;
      continue;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      mask[index++] = false;
      while (index < source.length) {
        const char = source[index];
        mask[index++] = false;
        if (char === "\\") {
          if (index < source.length) mask[index++] = false;
          continue;
        }
        if (char === quote) break;
      }
      continue;
    }
    index += 1;
  }
  return mask;
}

/**
 * An identifier, wherever one may start, and the head of a top-level exported type alias.
 *
 * Both are built per call rather than shared. A `g` flag carries `lastIndex` between uses, and
 * {@link inlineAliases} recurses — one shared instance would have an inner call move the outer's
 * cursor, which reads as a reference the generator simply skipped.
 */
const identifierPattern = (): RegExp => /[A-Za-z_$][A-Za-z0-9_$]*/g;
const typeAliasPattern = (): RegExp => /^export type ([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm;

/**
 * The source text of every top-level `export type X = …;` in a module, keyed by name.
 *
 * The value is the type node's own text, verbatim: every doc comment, every union arm, every `| null`
 * exactly as written. It is found by scanning for the `;` that closes the alias at bracket depth zero,
 * over code characters only.
 */
export function parseTypeAliases(source: string): Map<string, string> {
  const mask = codeMask(source);
  const aliases = new Map<string, string>();
  const pattern = typeAliasPattern();
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const [head, name] = match;
    const start = match.index;
    if (!mask[start] || !name) continue;
    const from = start + head.length;
    let depth = 0;
    let end = -1;
    for (let index = from; index < source.length; index += 1) {
      if (!mask[index]) continue;
      const char = source[index];
      if (char === "{" || char === "(" || char === "[") depth += 1;
      else if (char === "}" || char === ")" || char === "]") depth -= 1;
      else if (char === ";" && depth === 0) {
        end = index;
        break;
      }
    }
    if (end === -1) throw new Error(`\`export type ${name}\` is never closed by a \`;\` at depth zero.`);
    aliases.set(name, source.slice(from, end));
  }
  return aliases;
}

/** The leading spaces of the line `index` falls on. What an inlined alias has to be pushed out by. */
function indentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ ]*/.exec(text.slice(lineStart, index))?.[0] ?? "";
}

/**
 * Replace every reference to a sibling type alias with that alias's own text, re-indented to sit where
 * the reference did.
 *
 * `PaymentsClientProduct` is the only one today, and it is named rather than inlined at the source for
 * a reason #395 recorded — the annotation goes on the `.map` callback, where a fresh literal is still
 * checked in both directions. The declaration an adopter reads has no such seam to hang a name on, so
 * the shape is written where it is used.
 */
export function inlineAliases(
  text: string,
  aliases: ReadonlyMap<string, string>,
  seen: readonly string[] = [],
): string {
  const mask = codeMask(text);
  const parts: string[] = [];
  let cursor = 0;
  const pattern = identifierPattern();
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const name = match[0];
    const body = aliases.get(name);
    if (body === undefined || !mask[match.index]) continue;
    if (seen.includes(name)) throw new Error(`\`${name}\` refers to itself through ${seen.join(" → ")}.`);
    const indent = indentAt(text, match.index);
    const inlined = inlineAliases(body, aliases, [...seen, name]);
    parts.push(text.slice(cursor, match.index), reindent(inlined.trim(), indent));
    cursor = match.index + name.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Push every line but the first out by `indent`. The first is already sitting where it was written. */
function reindent(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line, position) => (position === 0 || line === "" ? line : `${indent}${line}`))
    .join("\n");
}

/**
 * Move a block from the column it was written at to the one it is emitted at.
 *
 * The alias text arrives at whatever depth its source file put it — a union's arms at two spaces, its
 * members at six. Inside a `declare module` block those want four and eight. So the block is dedented
 * by its own first line's indent and then pushed out uniformly, which keeps every relative depth,
 * including the ` *` continuation of a doc comment.
 */
function shift(text: string, indent: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  const base = /^[ ]*/.exec(lines[0] ?? "")?.[0] ?? "";
  return lines
    .map((line) => (line.startsWith(base) ? `${indent}${line.slice(base.length)}` : `${indent}${line.trimStart()}`))
    .join("\n");
}

/** One `declare module "virtual:pithy/<module>"` block, fixed text and declared shape together. */
export function renderModule(module: string, declaredType: string): string {
  return [
    `declare module "virtual:pithy/${module}" {`,
    ENABLED_EXPORT,
    "  const config:",
    `${shift(declaredType, "    ")};`,
    "  export default config;",
    "}",
    "",
  ].join("\n");
}

/**
 * The whole file, from each module's projection source.
 *
 * Pure, and the module list is an argument, so the test can hand it a projection this repository does
 * not contain and read what came out. A generator asserted only against the real four would pass just
 * as well if it ignored them and printed a constant.
 */
export function renderClientEnv(
  sources: ReadonlyMap<string, string>,
  modules: readonly DeclaredModule[] = DECLARED_MODULES,
): string {
  const blocks: string[] = [];
  for (const declared of modules) {
    const source = sources.get(declared.module);
    if (source === undefined) throw new Error(`No projection source for virtual:pithy/${declared.module}.`);
    const aliases = parseTypeAliases(source);
    const body = aliases.get(declared.type);
    if (body === undefined) throw new Error(`${declared.specifier} exports no type \`${declared.type}\`.`);
    aliases.delete(declared.type);
    blocks.push(renderModule(declared.module, inlineAliases(body, aliases)));
  }
  return `${PREAMBLE}\n${blocks.join("\n")}`;
}

/** Read the four projection sources through their own packages' exports maps. */
export async function readProjectionSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const declared of DECLARED_MODULES) {
    const path = fileURLToPath(import.meta.resolve(declared.specifier));
    sources.set(declared.module, await readFile(path, "utf8"));
  }
  return sources;
}

/** The declaration as it should be on disk. What `bun run generate` writes and the gate compares. */
export async function generateClientEnv(): Promise<string> {
  return renderClientEnv(await readProjectionSources());
}
