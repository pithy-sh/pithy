// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ClientProjection } from "@pithy-sh/core/src/capability/client";

/**
 * The import specifier a screen writes: `import auth from "virtual:pithy/auth"`. One module per
 * capability, resolved from the Worker's own `pithy.config.ts` — so a front end reads the backend it
 * is served by, and never a hand-copied duplicate of its config.
 */
export const VIRTUAL_PREFIX = "virtual:pithy/";

/**
 * The resolved id. The leading NUL is Rollup's convention for "this module has no file" — it stops
 * other plugins and the filesystem resolver from touching it.
 */
export const RESOLVED_PREFIX = "\0virtual:pithy/";

/**
 * A capability name as it may appear after the prefix: one segment, the same lowercase-hyphenated
 * shape as `pithy add <capability>`. Anything else (a path, an empty name, a traversal) is not ours,
 * so `resolveVirtualId` declines it and Vite reports its usual unresolved-import error.
 */
const CAPABILITY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** A key that can legally be re-exported as `export const <key>`. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Keys that are valid object keys but not valid binding names. A projection carrying one still
 * reaches the default export; only its named export is skipped, so nothing is silently lost.
 */
const RESERVED = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Map an import specifier to its resolved id, or `null` when the specifier is not a Pithy virtual module. */
export function resolveVirtualId(id: string): string | null {
  if (!id.startsWith(VIRTUAL_PREFIX)) return null;
  const name = id.slice(VIRTUAL_PREFIX.length);
  if (!CAPABILITY_NAME.test(name)) return null;
  return `${RESOLVED_PREFIX}${name}`;
}

/** The capability name carried by a resolved id, or `null` when the id is not one of ours. */
export function capabilityNameFromResolvedId(id: string): string | null {
  if (!id.startsWith(RESOLVED_PREFIX)) return null;
  const name = id.slice(RESOLVED_PREFIX.length);
  return CAPABILITY_NAME.test(name) ? name : null;
}

/** Whether a module id is a resolved Pithy virtual module — used to sweep the dev module graph. */
export function isResolvedVirtualId(id: string): boolean {
  return capabilityNameFromResolvedId(id) !== null;
}

/**
 * Render a projection as module source. Both shapes are emitted on purpose: the default export for
 * `import auth from "virtual:pithy/auth"`, and one named export per key so a bundler can tree-shake
 * `import { enabled } from "virtual:pithy/auth"` down to a single inlined literal.
 *
 * Every value is emitted through `JSON.stringify`, which is the second half of the security boundary
 * — the projection was already validated as JSON, and nothing but JSON can be written here.
 */
export function renderVirtualModule(projection: ClientProjection): string {
  const lines = [`export default ${JSON.stringify(projection)};`];
  for (const [key, value] of Object.entries(projection)) {
    if (value === undefined) continue;
    if (!IDENTIFIER.test(key) || RESERVED.has(key)) continue;
    lines.push(`export const ${key} = ${JSON.stringify(value)};`);
  }
  return `${lines.join("\n")}\n`;
}
