// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Reading a thrown value that no type describes — the one place the kit records **what a runtime does to
 * an error on its way out** (#223), and **the one place that decides whether what it says may be shown**
 * (#228).
 *
 * Nothing here classifies anything. Classification is policy and belongs to the surface that refuses:
 * which causes a loader recognizes, and what each refusal says, differ per surface and are meant to.
 * This module holds only what does not — the facts about the shapes a runtime hands over, and the filter
 * that decides whether one of its strings is safe to put in front of an adopter.
 *
 * **The filter is here for the same reason the facts are, and the argument took two issues to finish.**
 * #223 moved `rootCause` and `prop` in and deliberately left `safeReason` beside
 * the three refusals, on the reading that what a surface may say is that surface's business. That is true
 * of the sentences and false of the filter: whether a string carries a path, a stack frame or half a
 * parser's ANSI box is a property of the string, and the answer cannot differ between the CLI, a
 * capability loader and the vite plugin without one of them being wrong. It was three near-verbatim
 * copies, and the hole #223 found in it had to be closed three times (#228).
 *
 * `@pithy-sh/vite` depends on this package and on nothing else in the kit. That constraint is what made
 * core the right home for `rootCause`; it applies to the filter identically.
 */

/**
 * Read a property off an unknown throwable without widening anything to `any`.
 *
 * Deliberately duck-typed. A cause is `unknown`, and an `instanceof Error` gate is a claim about a
 * runtime's classes that the runtime can break. Bun did: on 1.3 its `ResolveMessage` and `BuildMessage`
 * were **not** `instanceof Error`, so a gate passed a whole suite under vitest, which runs on Node, and
 * silently dropped the parser's own sentence on the runtime that ships. That is #207. Bun 1.4 made both
 * real `Error`s (measured on 1.4.2), and nothing here had to change, which is the point: every reader of
 * a cause in this kit goes through this function and reads fields, never a class.
 *
 * Non-enumerable properties are read too — `AggregateError.errors` is one, and {@link rootCause}
 * depends on it.
 */
export function prop(cause: unknown, key: string): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  return (cause as Record<string, unknown>)[key];
}

/**
 * The diagnostic **inside** Bun's `AggregateError` wrapper — the thing a classifier must actually look at.
 *
 * `import()` on Bun hands one build diagnostic over bare and **two or more inside an `AggregateError`**,
 * whose own `message` is `N errors building "<absolute path>"` and whose `Object.keys` is empty. Node
 * throws the diagnostic directly, so no Node-shaped fixture can show this: it is found by running on Bun,
 * and only by running on Bun with a failure of the *realistic* shape.
 *
 * **And the realistic shape is the wrapped one.** A stray brace cascades — one missing `}` in a
 * `pithy.config.ts` produces four diagnostics on Bun 1.4.2 — so a syntax error arrives wrapped far more
 * often than bare. Classified as-is, the wrapper matches nothing: not a resolution failure, not a parse
 * error, just something with a message. The refusal then says *the config threw while loading, run the
 * file directly* while holding the line and column in its hand. #207 fixed the bare case and left this
 * one; #217 hit it in the capability loaders; #223 is it a third time, which is why it lives here.
 *
 * The **first** diagnostic only. The rest are the cascade, not the fault, and naming four positions
 * buries the one that matters.
 *
 * Bounded to four levels: a wrapper holding a wrapper is not a shape any runtime produces today, and an
 * unbounded walk over an adopter's own `errors` field is not something this should be talked into.
 * Anything else — a bare diagnostic, an empty `errors`, a non-array `errors` — is returned untouched, so
 * a runtime that stops wrapping needs no change here.
 */
export function rootCause(cause: unknown): unknown {
  let current = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    const errors = prop(current, "errors");
    if (!Array.isArray(errors) || errors.length === 0 || errors[0] === undefined) return current;
    current = errors[0];
  }
  return current;
}

/** Escape sequences a runtime colors its diagnostics with. They are formatting, and they never travel. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the control characters is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

/** Anything that looks like the start of an absolute path — POSIX, `~`, or a Windows drive. */
const ABSOLUTE_PATH = /(^|[\s'"(])(\/|~\/|[A-Za-z]:[\\/])/;

/** A stack frame, in the one spelling every runtime here agrees on. */
const STACK_FRAME = /\bat \S+:\d+:\d+/;

/** The longest a reason may be before it has stopped being a sentence and started being a diagnostic. */
const REASON_LIMIT = 160;

/**
 * The thrown value's message, **de-colored** — `undefined` when it has none.
 *
 * Duck-typed for {@link prop}'s reason. The de-coloring is here rather than at each caller because an
 * escape sequence is formatting the runtime added, not something a surface has an opinion about — and
 * because the three copies of this had already drifted: two stripped with `\u001b`, the third with a
 * literal escape character sitting in its source where no reviewer would see it (#228).
 *
 * This says what the cause *says*. Whether any of it may be shown is {@link safeReason}.
 */
export function causeMessage(cause: unknown): string | undefined {
  const message = prop(cause, "message");
  return typeof message === "string" ? message.replace(ANSI, "") : undefined;
}

/**
 * The cause's own message, but **only when the whole of it is one safe sentence** — the kit's single
 * decision about whether a runtime's string may reach an adopter (#228).
 *
 * A parser's reason (`Expected identifier but found "{"`) is a sentence an adopter acts on. The
 * diagnostic a bundler wraps the same fault in is a multi-line ANSI box quoting an absolute path and the
 * source line, which is throw-site context wearing a message's clothes. What is dropped here still
 * reaches `detail`, which the CLI renderer never prints and the HTTP codec strips — so a refusal costs a
 * developer one frame of digging, and a mistake puts a path, a source line or a stack frame in a field
 * that is rendered.
 *
 * A trailing period comes off: every caller puts this inside a sentence of its own.
 */
export function safeReason(cause: unknown): string | undefined {
  const text = (causeMessage(cause) ?? "").trim();
  if (text.length === 0 || text.length > REASON_LIMIT) return undefined;
  if (text.includes("\n")) return undefined;
  if (ABSOLUTE_PATH.test(text)) return undefined;
  if (STACK_FRAME.test(text)) return undefined;
  return text.replace(/\.$/, "");
}

/** Where a runtime says a failure was. Two numbers, and never the file they were quoted beside. */
export interface FailurePosition {
  /** 1-based line, as the runtime reported it. */
  line: number;
  /** Column, as the runtime reported it. */
  column: number;
}

/**
 * `line`/`column`, from the structured position where a runtime gives one, else from its own `…:LINE:COL`.
 *
 * A recorded fact about two runtimes: Bun's `BuildMessage` carries `position`, and a transform that has no
 * such field states the same thing in its message tail. Only the two numbers are lifted out — never the
 * path they are appended to. Whether a surface prints them is that surface's policy: two of the three
 * classifiers do, and the capability loader deliberately does not.
 */
export function failurePosition(cause: unknown): FailurePosition | undefined {
  const position = prop(cause, "position");
  const line = prop(position, "line");
  const column = prop(position, "column");
  if (typeof line === "number" && line > 0 && typeof column === "number") return { line, column };
  const match = /:(\d+):(\d+)/.exec(causeMessage(cause) ?? "");
  if (!match?.[1] || !match[2]) return undefined;
  return { line: Number(match[1]), column: Number(match[2]) };
}

/** What kind of thing failed to resolve. Three causes that wore one sentence until #489. */
export type UnresolvedKind =
  /** A bare specifier for a package that is not installed. Installing dependencies is the remedy. */
  | "package"
  /** An installed package asked for a subpath it does not provide. Installing again changes nothing. */
  | "package-subpath"
  /** A relative import of a file in the project's own tree. Installing again changes nothing. */
  | "local-file";

/** Whether a path sits inside an installed package. */
function insideNodeModules(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules");
}

/** A specifier that names a file rather than a package: `./`, `../`, `/`, or a Windows drive. */
const RELATIVE_OR_ABSOLUTE = /^(?:\.|\/|[A-Za-z]:[\\/])/;

/**
 * Whether `pkg` is installed where `referrer` would look for it. The caller's to answer: core touches no
 * filesystem, and on Bun 1.4 nothing in the cause says.
 */
export type InstalledProbe = (pkg: string, referrer: string) => boolean;

/**
 * Which of the three unresolved-import causes this was, or `undefined` when it cannot be told.
 *
 * **The discriminator was already in the message and was being thrown away.** `unresolvedSpecifier`
 * matches `Cannot find (?:package|module)` — and `package` versus `module` is exactly the fact that
 * separates a missing dependency from the other two. It sat in a non-capturing group, so every cause
 * arrived wearing one sentence, and for two of the three that sentence advised an install which is
 * *guaranteed* to change nothing. That is #489's class exactly: guidance a caller cannot follow, worst
 * for the caller it is written for, which has no human to shrug and try something else.
 *
 * Measured across Node 24.13.0 and Bun 1.4.2, because the two runtimes hand back different halves:
 *
 * | cause | Node says | Bun's `specifier` |
 * |---|---|---|
 * | package absent | `Cannot find package 'pkg'`, no `url` | `pkg`, or `pkg/src/x` |
 * | subpath missing | `Cannot find module '/abs/node_modules/pkg/src/nope.js'`, `url` under node_modules | `pkg/src/nope` |
 * | adopter's file | `Cannot find module '/abs/apps/board/src/x'`, `url` outside node_modules | `./src/x` |
 *
 * Node gives the **already-resolved path**, where being under `node_modules` settles it. Bun gives the
 * **specifier as written** and the **referrer**, the file the import was written in. Together they
 * settle every case but one. Vite 8.3.0's module runner, which loads the dev server's config, also gives
 * the specifier as written, with the importer in its prose and no `url`, so it is read the way Bun is.
 * So is Node's `No such built-in module: node:x`, which carries neither.
 *
 * **The one case is a bare name with a path after it, and Bun 1.4 does not say which it was (#709).** It
 * writes Node's sentence, `Cannot find package 'pkg' imported from <path>`, for `pkg/src/x` whether `pkg`
 * is absent or installed without that path, and the field is the same in both. Every kit import is a deep
 * path, so this is the common shape: a fresh clone with nothing installed, or #480's package whose own
 * dependency is not linked. Guessing *subpath* tells those adopters installing will not help, which is
 * the opposite of the fix. So `installed` asks the filesystem, from the referrer. Without it, or without a
 * referrer, this answers `undefined` and the caller says the hedged thing.
 */
export function unresolvedKind(cause: unknown, installed?: InstalledProbe): UnresolvedKind | undefined {
  const field = prop(cause, "specifier");
  if (typeof field === "string" && field.length > 0) return writtenKind(field, importerPath(cause), installed);

  if (/Cannot find package /.test(causeMessage(cause) ?? "")) return "package";

  const specifier = unresolvedSpecifier(cause);
  if (specifier === undefined) return undefined;

  // Node states an already-resolved path, and carries it as `url`. Under `node_modules` settles it.
  const url = prop(cause, "url");
  if (typeof url === "string" && url.length > 0) return fileKind(url);

  // No `url` means the specifier is as written: Vite's module runner, or Node's builtin loader.
  return writtenKind(specifier, importerPath(cause), installed);
}

/** A path that did not resolve: inside an installed package, or in the adopter's own tree. */
function fileKind(path: string): UnresolvedKind {
  return insideNodeModules(path) ? "package-subpath" : "local-file";
}

/**
 * The cause, from a specifier **as it was written** and the file it was written in — Bun's two fields.
 *
 * - A `file:` URL is a path. Bun 1.4.2 converts it before it reaches the field; one that arrives as a URL
 *   is read as the path it names, never as a package called `file:`.
 * - Any other scheme is the runtime's own. Bun 1.4.2 carries `node:nope` and `node:fs/promsies` as written,
 *   with `ERR_UNKNOWN_BUILTIN_MODULE`, and `bun:nope` the same way. The runtime is installed and does not
 *   provide that module, which is a subpath's remedy: installing will not help.
 * - A relative specifier, or a `#` one from the importer's own `imports` map, belongs to whoever wrote the
 *   import. Under `node_modules` that is a package, and the file is the package's to provide. Anywhere
 *   else it is the adopter's.
 * - An absolute path is judged by where it points.
 * - A bare name alone is the package itself. A bare name with a path after it is asked of `installed`.
 */
function writtenKind(
  specifier: string,
  referrer: string | undefined,
  installed: InstalledProbe | undefined,
): UnresolvedKind | undefined {
  if (specifier.startsWith("file:")) return fileKind(urlPath(specifier));
  // `node:nope`, `bun:nope`: the runtime provides these, so no install will. Never a package by its name.
  if (URL_SCHEME.test(specifier)) return "package-subpath";
  const inPackage = referrer !== undefined && insideNodeModules(referrer);
  if (specifier.startsWith("#") || specifier.startsWith(".")) {
    return inPackage ? "package-subpath" : fileKind(specifier);
  }
  if (RELATIVE_OR_ABSOLUTE.test(specifier)) return fileKind(specifier);

  const segments = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  if (segments.length <= nameLength) return "package";
  if (installed === undefined || referrer === undefined) return undefined;
  return installed(segments.slice(0, nameLength).join("/"), referrer) ? "package-subpath" : "package";
}

/** A specifier that opens with a URL scheme: `node:`, `bun:`, `data:`. A Windows drive letter is one letter. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/** The path a `file:` URL names, or the specifier itself when it will not parse as one. */
function urlPath(specifier: string): string {
  try {
    return decodeURIComponent(new URL(specifier).pathname);
  } catch {
    return specifier;
  }
}

/**
 * The specifier that did not resolve.
 *
 * A recorded fact about two runtimes: Bun's `ResolveMessage` carries it as a **field**, and Node states it
 * in prose. The field is preferred wherever there is one, because the prose around it names the referrer's
 * absolute path — the specifier is the adopter's own import, the referrer is our frame. Vite 8.3.0's
 * module runner states a missing relative file as `Failed to load url <specifier> (resolved id: …)`, and
 * Node states a missing builtin as `No such built-in module: <specifier>`. Both measured.
 *
 * Whether a surface names it, and what it advises when it does, is that surface's policy and stays there.
 */
export function unresolvedSpecifier(cause: unknown): string | undefined {
  const field = prop(cause, "specifier");
  if (typeof field === "string" && field.length > 0) return field;
  const message = causeMessage(cause) ?? "";
  const match =
    /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message) ??
    /^Failed to load url (\S+) \(resolved id: /.exec(message) ??
    /^No such built-in module: (\S+)$/.exec(message);
  return match?.[1];
}

/** A package name as npm allows one: an optional `@scope/`, and never a store's dot-directory. */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/**
 * The file the failing import was written in, as the runtime named it. **Module-private on purpose**: it
 * is an absolute path, and {@link importingPackage} exists to make sure only its package half leaves here.
 */
function importerPath(cause: unknown): string | undefined {
  const field = prop(cause, "referrer");
  if (typeof field === "string" && field.length > 0) return field;
  const message = causeMessage(cause) ?? "";
  // Node ends its sentence with the path, so it is taken to the end of the line — a directory may contain
  // a space. Vite's module runner writes the same sentence with the path quoted, and its own `ERR_LOAD_URL`
  // sentence names the importer before `. Does the file exist?` (Vite 8.3.0, measured).
  const match =
    / imported from '(.+)'$/.exec(message) ??
    / imported from (.+)$/.exec(message) ??
    /^Failed to load url \S+ \(resolved id: [^)]*\) in (.+)\. Does the file exist\?$/.exec(message);
  return match?.[1];
}

/**
 * The package whose own source contained the import that did not resolve — **never a path**.
 *
 * {@link unresolvedSpecifier} answers *what* did not resolve. This answers *where the import lives*, and
 * the two are different facts whenever the failing import is not the adopter's own. #480 is that case
 * verbatim: `pithy add email` on a fresh project refused with
 *
 * > Nothing resolves "@pithy-sh/core/src/capability/capability".
 *
 * while `@pithy-sh/core` resolved from the Worker at every step of the run, before and after. The
 * specifier was honest — the runtime really could not resolve it — but the import belonged to
 * `@pithy-sh/email`, which had just been installed and was the package genuinely not linked. So the
 * refusal named the one dependency that was definitely fine, and an adopter following it ran `bun
 * install` against a tree that already had core in it. The importer is the half that would have pointed
 * at `email`, and both runtimes hand it over: **Bun's `ResolveMessage` carries `referrer` as a field**
 * (measured on 1.4.2) and Node states it in prose as `imported from <path>`.
 *
 * **A package name, or nothing.** The referrer is an absolute path — our frame, and the reason
 * {@link unresolvedSpecifier} drops the prose around the specifier — so what travels is the one part of
 * it that is not a path: the package directory it sits under. A referrer outside `node_modules` is the
 * adopter's own file, and there is nothing to say about it that the refusal does not already say by
 * naming the config, so it answers `undefined` rather than a path. The path itself is never returned
 * from this module, which is what makes leaking it impossible rather than merely discouraged.
 *
 * The **last** `node_modules` in the path, because every store layout nests: pnpm's
 * `node_modules/.pnpm/<id>/node_modules/<pkg>` and Bun's isolated linker's
 * `node_modules/.bun/<pkg>@<version>/node_modules/<pkg>` (both measured) put the real owner last, and so
 * does an ordinary nested install. The name is then checked against what npm allows, so a store's own
 * bookkeeping directory (`.bun`, `.pnpm`, `hono@4.6.3`) can only ever answer nothing.
 *
 * Whether a surface names it, and what it advises when it does, is that surface's policy and stays there.
 */
export function importingPackage(cause: unknown): string | undefined {
  const referrer = importerPath(cause);
  if (referrer === undefined) return undefined;
  const segments = referrer.split(/[\\/]/);
  const at = segments.lastIndexOf("node_modules");
  const head = at === -1 ? undefined : segments[at + 1];
  if (head === undefined) return undefined;
  const name = head.startsWith("@") ? `${head}/${segments[at + 2] ?? ""}` : head;
  return PACKAGE_NAME.test(name) ? name : undefined;
}
