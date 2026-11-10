// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import type { TestBinding } from "@pithy-sh/core/src/capability/testBinding";
import { findNamedImport, type ScannedConfig, scanConfig } from "../capabilities/configImports";
import { readOptionalFile } from "./readOptionalFile";
import { type LockfileSync, writeRootConfig } from "./rootConfigImports";

/** The project-root Vitest config every `*.workers.test.ts` runs under. */
export const WORKERS_TEST_CONFIG = "vitest.workers.config.ts";

/** A binding a Workers test config can state: every kind but `unbound`. */
type StatedBinding = Exclude<TestBinding, { kind: "unbound" }>;

/** How an option holds its entries: a list of names, or an object keyed by name. */
type Shape = "list" | "object";

/**
 * The `miniflare` option each stated kind lives under, and the shape a new option of it is written in. Miniflare
 * also takes `d1Databases`, `kvNamespaces` and `r2Buckets` as an object of name to id, so an existing option is
 * written to in the shape it already has.
 */
const OPTION: Record<StatedBinding["kind"], { key: string; shape: Shape }> = {
  d1: { key: "d1Databases", shape: "list" },
  kv: { key: "kvNamespaces", shape: "list" },
  r2: { key: "r2Buckets", shape: "list" },
  ratelimit: { key: "ratelimits", shape: "object" },
  value: { key: "bindings", shape: "object" },
};

function isStated(binding: TestBinding): binding is StatedBinding {
  return binding.kind !== "unbound";
}

/**
 * The entry one binding adds to an option of `shape`: an element of a list, or a `key: value` member of an object.
 * A D1, KV or R2 binding in an object is keyed by its name and given its name as the id.
 */
function entryOf(binding: StatedBinding, shape: Shape): string {
  switch (binding.kind) {
    case "ratelimit":
      return `${binding.name}: { simple: { limit: ${binding.limit}, period: ${binding.period} } }`;
    case "value":
      return `${binding.name}: ${binding.export}()`;
    default:
      return shape === "list" ? `"${binding.name}"` : `${binding.name}: "${binding.name}"`;
  }
}

/** A bracketed span: the index of its opening bracket and of the bracket that closes it. */
interface Span {
  open: number;
  close: number;
}

/** A `key: value` property whose value is a bracketed span, with the index its key starts at. */
interface Property extends Span {
  start: number;
}

/** The bracket closing the one at `open`, skipping comments (already blanked) and literals. */
function closing(scanned: ScannedConfig, open: number): number {
  let depth = 0;
  for (let index = open; index < scanned.code.length; index += 1) {
    if (scanned.inLiteral[index]) continue;
    const char = scanned.code[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The value span of the property `key` directly inside `within`, when that value is an object or a list.
 * Only properties at the span's own depth count, so a nested key of the same name is not mistaken for it.
 */
function property(scanned: ScannedConfig, within: Span, key: string): Property | null {
  const pattern = new RegExp(`\\b${key}\\s*:\\s*([[{])`, "g");
  pattern.lastIndex = within.open + 1;
  for (let match = pattern.exec(scanned.code); match !== null; match = pattern.exec(scanned.code)) {
    if (match.index >= within.close) return null;
    if (scanned.inLiteral[match.index] || depthAt(scanned, within.open, match.index) !== 1) continue;
    const open = match.index + match[0].length - 1;
    return { start: match.index, open, close: closing(scanned, open) };
  }
  return null;
}

/** How many brackets are open at `index`, counting from `from`. */
function depthAt(scanned: ScannedConfig, from: number, index: number): number {
  let depth = 0;
  for (let at = from; at < index; at += 1) {
    if (scanned.inLiteral[at]) continue;
    const char = scanned.code[at];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
  }
  return depth;
}

/** The `miniflare: { … }` object of the `cloudflareTest` options, or `null` when the config has none. */
function miniflareBlock(scanned: ScannedConfig): Span | null {
  const match = /\bminiflare\s*:\s*\{/.exec(scanned.code);
  if (match === null || scanned.inLiteral[match.index]) return null;
  const open = match.index + match[0].length - 1;
  const close = closing(scanned, open);
  return close === -1 ? null : { open, close };
}

/** The shape the option at `span` is written in, read from its opening bracket. */
function shapeOf(scanned: ScannedConfig, span: Span): Shape {
  return scanned.code[span.open] === "[" ? "list" : "object";
}

/** Whether the config provides `binding` already. */
function provides(scanned: ScannedConfig, block: Span, binding: StatedBinding): boolean {
  const span = property(scanned, block, OPTION[binding.kind].key);
  return span !== null && elementStart(scanned, span, binding.name) !== null;
}

/** The index of the last character before `index` that is not whitespace in the scanned code. */
function lastCode(scanned: ScannedConfig, index: number): number {
  let at = index - 1;
  while (at >= 0 && /\s/.test(scanned.code[at] ?? "")) at -= 1;
  return at;
}

/** The leading whitespace of the line holding `index`. */
function indentAt(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
}

function splice(source: string, at: number, text: string): string {
  return `${source.slice(0, at)}${text}${source.slice(at)}`;
}

/** Add `entry` to the list or object at `span`, in the layout it is already written in. */
function appendTo(source: string, scanned: ScannedConfig, span: Span, entry: string, shape: Shape): string {
  const last = lastCode(scanned, span.close);
  if (last === span.open) {
    return `${source.slice(0, span.open + 1)}${shape === "list" ? entry : ` ${entry} `}${source.slice(span.close)}`;
  }
  const trailingComma = scanned.code[last] === ",";
  if (source.slice(last + 1, span.close).includes("\n")) {
    return splice(
      source,
      last + 1,
      `${trailingComma ? "" : ","}\n${indentAt(source, last)}${entry}${trailingComma ? "," : ""}`,
    );
  }
  return splice(source, last + 1, `${trailingComma ? " " : ", "}${entry}`);
}

/** Add a new `key: value` property at the end of the `miniflare` block. */
function addProperty(source: string, scanned: ScannedConfig, block: Span, key: string, value: string): string {
  const last = lastCode(scanned, block.close);
  const indent = last === block.open ? `${indentAt(source, block.open)}  ` : indentAt(source, last);
  const comma = last === block.open || scanned.code[last] === "," ? "" : ",";
  return splice(source, last + 1, `${comma}\n${indent}${key}: ${value},`);
}

/** Import `name` from `module`, placed among the config's imports in specifier order. */
function withImport(source: string, name: string, module: string): string {
  if (findNamedImport(source, name) !== undefined) return source;
  const statement = `import { ${name} } from "${module}";\n`;
  const imports = [...scanConfig(source).code.matchAll(/^import\s[^;]*?from\s*(["'])([^"']+)\1;?[ \t]*\n/gm)];
  const after = imports.find((match) => (match[2] ?? "") > module);
  if (after !== undefined) return splice(source, after.index, statement);
  const last = imports.at(-1);
  return last === undefined ? `${statement}${source}` : splice(source, last.index + last[0].length, statement);
}

/** What {@link withTestBindings} did to one config. */
export interface TestBindingsEdit {
  /** The config with every binding it could place. */
  source: string;
  /** The bindings this edit wrote, in declaration order. */
  written: string[];
  /** The stated bindings it could not place, because the config has no `miniflare` block. */
  unplaced: string[];
}

/**
 * Add each stated binding a Workers test config does not provide yet. Idempotent, comment-aware, and a binding
 * already present is left as the adopter wrote it. An `unbound` binding states nothing.
 */
export function withTestBindings(original: string, bindings: readonly TestBinding[]): TestBindingsEdit {
  let source = original;
  const written: string[] = [];
  const unplaced: string[] = [];
  for (const binding of bindings.filter(isStated)) {
    const scanned = scanConfig(source);
    const block = miniflareBlock(scanned);
    if (block === null) {
      unplaced.push(binding.name);
      continue;
    }
    if (provides(scanned, block, binding)) continue;
    const { key } = OPTION[binding.kind];
    const span = property(scanned, block, key);
    const shape = span === null ? OPTION[binding.kind].shape : shapeOf(scanned, span);
    const entry = entryOf(binding, shape);
    source =
      span === null
        ? addProperty(source, scanned, block, key, shape === "list" ? `[${entry}]` : `{ ${entry} }`)
        : appendTo(source, scanned, span, entry, shape);
    if (binding.kind === "value") source = withImport(source, binding.export, binding.module);
    written.push(binding.name);
  }
  return { source, written, unplaced };
}

/** The stated bindings a Workers test config does not provide. With no `miniflare` block, every one of them. */
export function missingTestBindings(source: string, bindings: readonly TestBinding[]): StatedBinding[] {
  const scanned = scanConfig(source);
  const block = miniflareBlock(scanned);
  return bindings.filter(isStated).filter((binding) => block === null || !provides(scanned, block, binding));
}

/**
 * Write a capability's test bindings into the project's Workers test config, returning the notes `pithy add`
 * prints: one for the bindings no test config can provide, one for those this config had nowhere to put. The
 * write goes through {@link writeRootConfig}, so a package a value binding imports is declared at the root and
 * `sync` runs when that changed the root `package.json`. A project with no Workers test config is left alone.
 */
export async function writeTestBindings(
  projectDir: string,
  capability: string,
  bindings: readonly TestBinding[],
  sync?: LockfileSync,
): Promise<string[]> {
  const notes: string[] = [];
  const unbound = bindings.filter((binding) => !isStated(binding)).map((binding) => binding.name);
  const path = join(projectDir, WORKERS_TEST_CONFIG);
  const original = await readOptionalFile(path);
  if (original === null) return notes;
  if (unbound.length > 0) {
    notes.push(
      `${capability}: ${WORKERS_TEST_CONFIG} cannot bind ${unbound.join(", ")}. A Workers test that sends a request through the Worker's fetch answers 500 without it.`,
    );
  }
  const { source, unplaced } = withTestBindings(original, bindings);
  await writeRootConfig({ projectDir, file: WORKERS_TEST_CONFIG, original, source, ...(sync ? { sync } : {}) });
  if (unplaced.length > 0) {
    notes.push(
      `${capability}: add ${unplaced.join(", ")} to the miniflare options in ${WORKERS_TEST_CONFIG}. No miniflare block was found to write them into.`,
    );
  }
  return notes;
}

/**
 * The bindings the starter's Workers test config states for the app's own code. Taking a capability's test
 * bindings out never removes them, whichever capability declared them too.
 */
export const STARTER_TEST_BINDINGS: readonly string[] = ["DB", "SESSIONS"];

/** The index of the first character at or after `index` that is not whitespace in the scanned code. */
function nextCode(scanned: ScannedConfig, index: number): number {
  let at = index;
  while (at < scanned.code.length && /\s/.test(scanned.code[at] ?? "")) at += 1;
  return at;
}

/**
 * Where the entry named `name` starts directly inside `span`, or `null` when it holds none: a quoted list element
 * or object key, or a bare object key. Read from the scanned code, so a commented-out entry is not one, and only
 * a name that opens an entry counts, so another entry's value is not one either.
 */
function elementStart(scanned: ScannedConfig, span: Span, name: string): number | null {
  const pattern = new RegExp(`(["'])${name}\\1|\\b${name}\\s*:`, "g");
  pattern.lastIndex = span.open + 1;
  for (let match = pattern.exec(scanned.code); match !== null; match = pattern.exec(scanned.code)) {
    if (match.index >= span.close) return null;
    if (scanned.inLiteral[match.index] || depthAt(scanned, span.open, match.index) !== 1) continue;
    const before = lastCode(scanned, match.index);
    if (before === span.open || scanned.code[before] === ",") return match.index;
  }
  return null;
}

/** The end of the element starting at `start`: just past its last character before the next comma or the close. */
function elementEnd(scanned: ScannedConfig, span: Span, start: number): number {
  let depth = 0;
  for (let at = start; at < span.close; at += 1) {
    if (scanned.inLiteral[at]) continue;
    const char = scanned.code[at];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) return lastCode(scanned, at) + 1;
  }
  return lastCode(scanned, span.close) + 1;
}

/** Take the element at `start`..`end` out of `span` with the comma that separates it, keeping the layout around it. */
function cut(source: string, scanned: ScannedConfig, span: Span, start: number, end: number): string {
  const before = lastCode(scanned, start);
  if (before !== span.open && scanned.code[before] === ",") return `${source.slice(0, before)}${source.slice(end)}`;
  const after = nextCode(scanned, end);
  if (scanned.code[after] === ",") return `${source.slice(0, start)}${source.slice(nextCode(scanned, after + 1))}`;
  return `${source.slice(0, start)}${source.slice(end)}`;
}

/** Take the `miniflare` property `key` out when nothing is left in it. */
function withoutEmptyProperty(source: string, key: string): string {
  const scanned = scanConfig(source);
  const block = miniflareBlock(scanned);
  if (block === null) return source;
  const span = property(scanned, block, key);
  if (span === null || lastCode(scanned, span.close) !== span.open) return source;
  return cut(source, scanned, block, span.start, span.close + 1);
}

/** Take out the `import { <name> } from "<module>";` a value binding brought, once nothing else names `name`. */
function withoutImport(source: string, name: string, module: string): string {
  const scanned = scanConfig(source);
  const uses = [...scanned.code.matchAll(new RegExp(`\\b${name}\\b`, "g"))].filter(
    (match) => !scanned.inLiteral[match.index],
  );
  if (uses.length !== 1) return source;
  const statement = new RegExp(
    `^import\\s*\\{\\s*${name}\\s*\\}\\s*from\\s*(["'])${module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\1;?[ \\t]*\\n`,
    "m",
  ).exec(scanned.code);
  return statement === null
    ? source
    : `${source.slice(0, statement.index)}${source.slice(statement.index + statement[0].length)}`;
}

/** What {@link withoutTestBindings} did to one config. */
export interface TestBindingsRemoval {
  /** The config without the bindings it took out. */
  source: string;
  /** The bindings this edit took out, in declaration order. */
  removed: string[];
}

/**
 * Take each stated binding out of a Workers test config: the inverse of {@link withTestBindings}. A property left
 * empty goes with it, and so does a value binding's import once nothing else uses it. The starter's own bindings
 * ({@link STARTER_TEST_BINDINGS}) stay, and a binding the config does not state is no change.
 */
export function withoutTestBindings(original: string, bindings: readonly TestBinding[]): TestBindingsRemoval {
  let source = original;
  const removed: string[] = [];
  for (const binding of bindings.filter(isStated)) {
    if (STARTER_TEST_BINDINGS.includes(binding.name)) continue;
    const scanned = scanConfig(source);
    const block = miniflareBlock(scanned);
    if (block === null) break;
    const { key } = OPTION[binding.kind];
    const span = property(scanned, block, key);
    const start = span === null ? null : elementStart(scanned, span, binding.name);
    if (span === null || start === null) continue;
    source = withoutEmptyProperty(cut(source, scanned, span, start, elementEnd(scanned, span, start)), key);
    if (binding.kind === "value") source = withoutImport(source, binding.export, binding.module);
    removed.push(binding.name);
  }
  return { source, removed };
}

/**
 * Take test bindings out of the project's Workers test config, returning the names taken out. The write goes
 * through {@link writeRootConfig}, so the root `devDependency` of a package no root file imports any more goes with
 * it. A project with no Workers test config is left alone.
 */
export async function removeTestBindings(
  projectDir: string,
  bindings: readonly TestBinding[],
  sync?: LockfileSync,
): Promise<string[]> {
  const original = await readOptionalFile(join(projectDir, WORKERS_TEST_CONFIG));
  if (original === null) return [];
  const { source, removed } = withoutTestBindings(original, bindings);
  await writeRootConfig({ projectDir, file: WORKERS_TEST_CONFIG, original, source, ...(sync ? { sync } : {}) });
  return removed;
}
