// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { BUILT_IN_PRIVACY_CLASSES, PrivacyClassName } from "@pithy-sh/core/src/privacy/classes";
import { matchBrace, objectProperties } from "../capabilities/reconcile";
import { loadProject, loadProjectPrivacy, type ProjectConfig } from "../project/config";

/**
 * **The one writer of the root `privacy` key** (#132) — what `pithy privacy enable` declares classes with.
 *
 * It writes the way the Turnstile sitekey writer does, for its reasons: **literals, in place, and nothing else**,
 * then **a read-back through the real loader**. The object the root `pithy.config.ts` default-exports is located —
 * `export default { … }`, or `export default config` over a `const config = { … }`, which is the starter's shape —
 * and a `privacy` key is added to it, or an existing literal one rewritten. An adopter's expression is never
 * flattened: a run that would have to is refused, naming the line to write by hand, before a byte changes.
 *
 * **Additive.** The classes asked for join the ones already declared, so a re-run is a no-op and a second
 * `--class` widens rather than replaces. Narrowing a declaration is an edit somebody makes on purpose, by hand.
 */

/** What {@link declarePrivacyClasses} takes. */
export interface DeclarePrivacyOptions {
  /** The project root, where the root `pithy.config.ts` lives. */
  projectDir: string;
  /** The classes to declare, beside any already declared. */
  classes: readonly string[];
  /** How the config is read back. Defaults to a fresh `loadProject`, because the module cache holds the old file. */
  loadConfig?: (projectDir: string) => Promise<ProjectConfig>;
}

/** What {@link declarePrivacyClasses} did. */
export interface DeclaredPrivacy {
  /** The root config's path. */
  path: string;
  /** Every class now declared, built-ins first in their fixed order, then the rest by name. */
  classes: string[];
  /** Whether a byte changed. False on a re-run. */
  changed: boolean;
}

/** Classes in report order. */
function ordered(classes: Iterable<string>): string[] {
  const builtIn: readonly string[] = BUILT_IN_PRIVACY_CLASSES;
  const all = [...new Set(classes)];
  return [...builtIn.filter((name) => all.includes(name)), ...all.filter((name) => !builtIn.includes(name)).sort()];
}

/** The literal this writes, and what the refusal tells an adopter to write. */
function literal(classes: readonly string[]): string {
  return `{ classes: [${classes.map((name) => JSON.stringify(name)).join(", ")}] }`;
}

/** The refusal for a config this cannot write: what to add, by hand. */
function byHand(path: string, classes: readonly string[], why: string): ValidationError {
  return new ValidationError({
    message: `Could not write the privacy declaration into ${path}. ${why}`,
    action: `Add \`privacy: ${literal(classes)},\` to the object pithy.config.ts exports, by hand, then run the command again.`,
  });
}

/** The braces of the object the root config default-exports, or `null` when it is not a literal this can find. */
function exportedObject(source: string): { open: number; close: number } | null {
  const direct = /export\s+default\s+\{/.exec(source);
  let open = direct ? direct.index + direct[0].length - 1 : -1;
  if (open === -1) {
    const named = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(source);
    if (!named) return null;
    const declaration = new RegExp(`(?:const|let|var)\\s+${named[1]}\\s*(?::[^=]+)?=\\s*\\{`).exec(source);
    if (!declaration) return null;
    open = declaration.index + declaration[0].length - 1;
  }
  const close = matchBrace(source, open);
  return close === -1 ? null : { open, close };
}

/** Whether a property's source is the literal this writes — the only existing value it will replace. */
function isPlainDeclaration(text: string): boolean {
  return /^\{\s*classes\s*:\s*\[\s*(?:(?:"[a-z0-9_]*"|'[a-z0-9_]*')\s*,?\s*)*\]\s*,?\s*\}$/.test(text);
}

/** The starter's commented-out `// privacy: { … },` line inside the exported object, or `null`. */
function commentedExample(
  source: string,
  object: { open: number; close: number },
): { start: number; end: number; indent: string } | null {
  const pattern = /^([ \t]*)\/\/ privacy: \{ classes: \[[^\]\n]*\] \},[ \t]*$/gm;
  pattern.lastIndex = object.open;
  const match = pattern.exec(source);
  if (!match || match.index > object.close) return null;
  return { start: match.index, end: match.index + match[0].length, indent: match[1] ?? "" };
}

/** The indentation of the line `index` sits on. */
function indentAt(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
}

/** The comment the inserted key carries, because `pithy.config.ts` is written with comments. */
const COMMENT = [
  "// The privacy classes this project handles. Declaring any closes `console`:",
  `// \`${commandName("deploy")}\` refuses while Biome's suspicious/noConsole is off. A field`,
  "// is marked in its schema — pii(z.string()) — and the control plane reports",
  `// declared beside observed. \`${commandName("privacy enable")}\` writes this key.`,
];

/**
 * Declare `classes` in the root config, beside whatever it already declares. All or nothing: a config this cannot
 * write is refused before the file is touched, and a read-back that disagrees puts the file back.
 */
export async function declarePrivacyClasses(options: DeclarePrivacyOptions): Promise<DeclaredPrivacy> {
  for (const name of options.classes) {
    if (!PrivacyClassName.safeParse(name).success) {
      throw new ValidationError({
        message: `"${name}" is not a privacy class name.`,
        action: "Name a class with a lowercase identifier — `secret`, `pii`, `phi`, `pci`, or one you registered.",
      });
    }
  }
  const load = options.loadConfig ?? ((projectDir: string) => loadProject(projectDir, { fresh: true }));
  const path = join(options.projectDir, "pithy.config.ts");
  const before = loadProjectPrivacy(await load(options.projectDir));
  const classes = ordered([...before, ...options.classes]);
  if (classes.length === before.length && classes.every((name) => before.includes(name))) {
    return { path, classes, changed: false };
  }

  const original = await readFile(path, "utf8");
  const object = exportedObject(original);
  if (object === null) {
    throw byHand(path, classes, "It does not default-export an object literal this can find.");
  }
  const properties = objectProperties(original, object.open, object.close);
  const existing = properties.find((property) => property.key === "privacy");
  let source: string;
  if (existing) {
    if (!isPlainDeclaration(original.slice(existing.valueStart, existing.valueEnd))) {
      throw byHand(path, classes, "Its `privacy` value is an expression, and an expression is never flattened.");
    }
    source = `${original.slice(0, existing.valueStart)}${literal(classes)}${original.slice(existing.valueEnd)}`;
  } else if (commentedExample(original, object) !== null) {
    // The starter's own commented-out example, uncommented in place: its explanation is already above it.
    const example = commentedExample(original, object) as { start: number; end: number; indent: string };
    source = `${original.slice(0, example.start)}${example.indent}privacy: ${literal(classes)},${original.slice(example.end)}`;
  } else {
    const last = properties.at(-1);
    const indent = last ? indentAt(original, last.valueStart) : "  ";
    let anchor = object.open + 1;
    let separator = "";
    if (last) {
      anchor = last.valueEnd;
      // Past the comma that ends the last property, when it has one; one is supplied when it does not.
      const rest = original.slice(anchor, object.close);
      const comma = /^\s*,/.exec(rest);
      if (comma) anchor += comma[0].length;
      else separator = ",";
    }
    const block = [
      `${separator}\n`,
      "\n",
      ...COMMENT.map((line) => `${indent}${line}\n`),
      `${indent}privacy: ${literal(classes)},`,
    ].join("");
    source = `${original.slice(0, anchor)}${block}${original.slice(anchor)}`;
  }
  await writeFile(path, source);

  let after: string[];
  try {
    after = loadProjectPrivacy(await load(options.projectDir));
  } catch (cause) {
    await writeFile(path, original);
    throw cause;
  }
  if (after.length !== classes.length || !classes.every((name) => after.includes(name))) {
    await writeFile(path, original);
    throw new InternalError({
      message: `The privacy declaration written to ${path} is not what the config reads back. The file was restored.`,
      action: `Add \`privacy: ${literal(classes)},\` to the object pithy.config.ts exports, by hand.`,
      detail: `read back ${JSON.stringify(after)}`,
    });
  }
  return { path, classes, changed: true };
}
