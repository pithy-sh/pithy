// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { packageOf } from "../naming/packageName";
import { causeMessage, prop, rootCause } from "./cause";

/**
 * **An import that would not resolve: which kind it was, whose it was, and the one thing to do about it —
 * decided here and nowhere else (#709).**
 *
 * Three surfaces refuse a module that will not load: the CLI's `pithy.config.ts` loader, its capability
 * loaders, and the vite plugin's Worker config. Each read core's facts and then kept its own rules for the
 * rest — builtins, `#` imports, `file:` URLs, an unexported subpath, a package name. Three review rounds
 * each found one of them giving advice the others had stopped giving: `bun install` where installing
 * cannot help, an absolute path in a rendered field, a dependency's fault blamed on the capability. Fixing
 * them site by site fixed today's three and left the class. So the rules moved here, the surfaces keep
 * none, and `packages/cli/src/project/unresolvedSurfaces.test.ts` feeds every kind through all three.
 *
 * What a surface still owns is what is genuinely its own: a capability loader knows which package it was
 * loading, and an absent *capability* is `pithy add`, not `bun install`. That is a fact about the target,
 * not about the import, and it is the only override any surface makes.
 *
 * ## The two runtimes hand back different halves
 *
 * Measured on Bun 1.4.2 and Node 22.23.3 (Node 24.21.0 throws the same), importing a real tree:
 *
 * | the import | Bun 1.4.2 | Node 22 |
 * |---|---|---|
 * | absent package | `specifier`, `referrer`, `Cannot find package` | `Cannot find package 'pkg'` |
 * | deep import, package absent **or** installed without it | the same sentence for both | `Cannot find package 'pkg'`, or the resolved `url` |
 * | unexported subpath | the same sentence again | `ERR_PACKAGE_PATH_NOT_EXPORTED` |
 * | `node:nope` | `ERR_UNKNOWN_BUILTIN_MODULE`, `specifier`, `referrer` | the code and sentence, nothing else |
 * | `bun:nope` | `Cannot find package 'nope'` — the scheme is dropped | `ERR_UNSUPPORTED_ESM_URL_SCHEME` |
 * | the adopter's file | the import as written, `referrer` | the resolved `url` |
 * | `#internal` | `Cannot find package '#internal'` | `ERR_PACKAGE_IMPORT_NOT_DEFINED` |
 * | installed package, `exports` with no `"."` | `Cannot find package 'pkg'` — the sentence for an absent one | `No "exports" main defined in …/pkg/package.json` |
 * | installed package, `main` names a missing file | the same sentence again | `Cannot find package '…/node_modules/pkg/<main>'` |
 * | installed package, `exports` `"."` names a missing file | the same sentence again | the resolved `url` of that file |
 * | deep import, an `exports` pattern maps it to a missing file | the import as written, `referrer` | the resolved `url` of that file |
 * | a `file:` URL | converted to a path | the resolved `url` |
 * | a package's own relative import | the import as written, `referrer` in the package | the resolved `url` |
 *
 * Node gives the **already-resolved path**; Bun gives the **import as written** and the file it was
 * written in. Both are read to one path before anything is decided, so a remedy does not depend on the
 * runtime it was read on. Where Bun says less than Node — an unexported subpath reads as a missing one —
 * the two share a remedy, which is the only way to keep them agreeing.
 *
 * **A bare name is asked of the probe too.** Bun 1.4.2 says `Cannot find package 'pkg'` for a package that
 * is installed and has no entry to import by its bare name — every `@pithy-sh/*` package, whose `exports`
 * map has no `"."` — exactly as it says it for one that is absent. Taken at face value, that told an
 * adopter to install what was installed. So a bare name the probe finds is an installed package with no
 * usable entry, named by the package, and Node's two sentences for the same tree read to the same remedy.
 *
 * **And so is its `package.json`.** Bun says the same sentence again for a package that *declares* an entry
 * whose file is not there — an unbuilt workspace package, a broken install — and Node hands back that
 * file's path, so a bare import read as a deep one the adopter never wrote. Neither is "no entry": it is
 * that package to rebuild or reinstall. Only the manifest says which, so {@link packageEntryProbe} reads
 * it, and every runtime's shape for the same tree reads to the same kind.
 *
 * **And a deep import is resolved through `exports` too.** Every `@pithy-sh/*` package exports `./src/*` as
 * `./dist/*.js`, so in an unbuilt one every deep import matches the pattern and lands on a file that is not
 * there. Bun and Vite hand back the import as written and Node the `dist` file it resolved to; read at
 * face value, the first two told an adopter the package does not provide a path it declares, and Node
 * quoted a path nobody wrote. So the import is resolved through the manifest — patterns and conditions,
 * as the runtimes do — and Node's file is mapped back to the import that reaches it, which is what is
 * shown. A target the manifest declares and the disk does not have is {@link exportedKind}'s to call.
 *
 * ## Vite's module runner says it a third way
 *
 * The vite plugin loads a config through `runnerImport` (Vite 8.3.0, measured), which resolves bare
 * imports itself before any runtime does and throws its own shapes: `PLUGIN_ERROR` with
 * *`"." is not exported under the conditions [...] from package <dir>`* for an `exports` map with no
 * usable `"."` (or `"./sub"` for an unexported subpath), and `ERR_RESOLVE_PACKAGE_ENTRY_FAIL` —
 * *Failed to resolve entry for package "pkg"* — for every other bare name with nothing on disk to load,
 * declared or not. Neither names an importer, so the manifest is found from the project instead.
 *
 * **Bun 1.4.2 cannot be told from an absent package for `bun:nope`.** It drops the scheme and reports a
 * package called `nope`, with nothing left in the cause to say otherwise. That one reads as an absent
 * package, and is the one remedy here that a runtime takes out of this module's hands.
 *
 * ## Never a path, never a URL
 *
 * Every rendered field is built from what {@link UnresolvedImport.shown} allows: a bare specifier, a
 * path relative to the project, or a path inside a package named from that package. An absolute path or
 * a `file:` URL is never returned from here, so a surface cannot render one.
 *
 * ## A package that resolves and will not load
 *
 * One more failure belongs to an installed package and reads, unclassified, as the adopter's: a package
 * whose code contradicts the `"type"` its `package.json` declares. Node throws it from inside that package
 * — `module is not defined in ES module scope`, `Cannot use import statement outside a module` — and Vite's
 * runner hands the import to Node, so it throws the same. Nothing resolves wrongly, so it is not an
 * {@link unresolvedImport}; but a surface that falls through to its own rules says *the config threw* or
 * *the config does not parse*. {@link packageLoadFailure} names the package instead, from the file the
 * error was thrown in, and every surface asks it before deciding the failure was its own.
 */

/** Which of the causes it was. Each has one remedy, and only three of them say to install. */
export type UnresolvedImportKind =
  /** A package that is not installed. Installing is the remedy. */
  | "package"
  /**
   * An installed package asked for a path it does not have, or does not export — or asked by its bare name
   * when it has no entry there. Installing changes nothing.
   */
  | "package-subpath"
  /**
   * An installed package whose `package.json` names an entry — `exports` `"."` or `main` — that is not on
   * disk: unbuilt, or a broken install. That package is rebuilt or reinstalled; the project's install
   * does not touch a package it already has.
   */
  | "package-entry"
  /** An installed package's own relative import of its own file. Its maintainer's, never an install. */
  | "package-file"
  /** A module the runtime provides, or does not: `node:nope`. Installing cannot add one. */
  | "builtin"
  /** A file in the adopter's own tree, a `file:` URL included. Theirs to create or correct. */
  | "local-file"
  /** A `#` import its importer's own `imports` map does not satisfy. Theirs, or the package's maintainer's. */
  | "imports-map"
  /** A deep import, and nothing to say whether its package is absent or only the path is. Both remedies. */
  | "undetermined"
  /** A resolution failure that names nothing. Both remedies. */
  | "unnamed";

/** One unresolved import, classified. Every field may be rendered: none carries a path or a URL. */
export interface UnresolvedImport {
  /** Which cause it was. */
  kind: UnresolvedImportKind;
  /** The import as it may be shown: a bare specifier, `./`-relative to the project, or `<package>/<path>`. */
  shown?: string;
  /** The package the import named, for the kinds that name one. */
  package?: string;
  /** The package whose file holds the import. Absent when that is the adopter's own code, or not said. */
  owner?: string;
  /** Whether installing the project's dependencies can fix it. */
  installHelps: boolean;
  /** The one sentence every surface puts in its `action`. */
  remedy: string;
}

/**
 * Whether `pkg` is installed where `referrer` would look for it. The caller's to answer: core touches no
 * filesystem, and on Bun 1.4.2 nothing in the cause says. {@link nodeModulesProbe} builds the answer.
 */
export type InstalledProbe = (pkg: string, referrer: string) => boolean;

/** What a surface tells the classifier about where it stands. */
export interface UnresolvedImportOptions {
  /** Answers the one question the cause cannot. Without it, a deep import is `undetermined`. */
  installed?: InstalledProbe;
  /**
   * Answers the next one: what an installed package declares, and what of it is on disk. Without it, Bun's
   * bare name is taken to have no entry there, a loader that names the file or the package it could not
   * load — Node reaching for a `main`, Vite's *Failed to resolve entry* — is taken to have reached for a
   * declared one, and a deep import is a path the package does not provide.
   */
  entry?: EntryProbe;
  /** The directory an adopter's paths are shown relative to. Without it, a resolved path is never shown. */
  relativeTo?: string;
  /** The package doing the importing — `@pithy-sh/cli`, `@pithy-sh/vite`. Never named as an owner. */
  loader?: string;
}

/**
 * An installed `pkg` found on the chain above `from`: its manifest, and whether a path inside it is on disk.
 * `undefined` when there is no such package, or no manifest to read. {@link packageEntryProbe} builds the
 * answer; what the manifest *means* — the entry it declares, where an `exports` pattern leads — is decided
 * here, by {@link declaredEntry} and {@link exportedTarget}, so no surface reads a manifest its own way.
 */
export type EntryProbe = (pkg: string, from: string) => InstalledPackage | undefined;

/** What {@link EntryProbe} answers: one installed package's manifest, and its directory to ask of. */
export interface InstalledPackage {
  /** Its `package.json`, parsed. */
  manifest: unknown;
  /** Whether a path inside the package — a file or a directory, `""` for the package itself — is on disk. */
  has(path: string): boolean;
}

/** The two filesystem calls {@link nodeModulesProbe} makes. `node:fs`'s `existsSync` and `realpathSync`. */
export interface ProbeFileSystem {
  /** Whether a file is there. */
  exists(path: string): boolean;
  /** Where a path really is, through every symlink. May throw for a path that is not there. */
  realpath(path: string): string;
}

/**
 * The {@link InstalledProbe} a surface on Node or Bun passes: `pkg` on the `node_modules` chain above
 * `referrer`, **walked from where `referrer` really is**.
 *
 * Both runtimes resolve from the real path of the importing file, and Bun's isolated linker puts every
 * package behind a symlink into its store, with that package's own dependencies beside the real
 * directory and not beside the link. Walked from the link, the chain is the root's — a different copy,
 * or none — so a dependency the resolver could see was reported absent, and the adopter told to install
 * what was installed. A `referrer` that will not resolve is walked as given.
 *
 * Core has no filesystem, so the two calls are the caller's. The walk is here, once.
 */
export function nodeModulesProbe(fs: ProbeFileSystem): InstalledProbe {
  return (pkg, referrer) => installedAt(fs, pkg, referrer) !== undefined;
}

/**
 * The {@link EntryProbe} a surface on Node or Bun passes: the same walk as {@link nodeModulesProbe}, then
 * the package's own `package.json`, and `exists` for the paths beside it.
 */
export function packageEntryProbe(fs: ProbeFileSystem & { read(path: string): string }): EntryProbe {
  return (pkg, from) => {
    const dir = installedAt(fs, pkg, from);
    if (dir === undefined) return undefined;
    let manifest: unknown;
    try {
      manifest = JSON.parse(fs.read(`${dir}/package.json`));
    } catch {
      return undefined;
    }
    return { manifest, has: (path) => fs.exists(path === "" ? dir : `${dir}/${path}`) };
  };
}

/** The entry an installed `pkg` declares, through the probe: `undefined` when there is no probe or no package. */
function declaredBy(options: UnresolvedImportOptions, pkg: string, from: string): string | null | undefined {
  const installed = options.entry?.(pkg, from);
  return installed === undefined ? undefined : declaredEntry(installed.manifest);
}

/** The directory `pkg` is installed in on the chain above `referrer`, walked from where it really is. */
function installedAt(fs: ProbeFileSystem, pkg: string, referrer: string): string | undefined {
  let real = referrer;
  try {
    real = fs.realpath(referrer);
  } catch {
    // Not there to resolve. The chain above where it was said to be is the best there is.
  }
  let dir = parentOf(real);
  for (;;) {
    const at = `${dir.replace(/[\\/]+$/, "")}/node_modules/${pkg}`;
    if (fs.exists(`${at}/package.json`)) return at;
    const up = parentOf(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The conditions an ESM import of a package matches, on Node and on Vite's runner. */
const IMPORT_CONDITIONS = new Set(["import", "node", "module-sync", "default"]);

/**
 * The entry a manifest declares for an `import` of the package's bare name, or `null` for none. `exports`
 * wins when present — its `"."`, or the whole map when no key is a subpath — and a target is the first
 * one whose condition an import matches. With no `exports`, it is `main`.
 */
export function declaredEntry(manifest: unknown): string | null {
  const exports = prop(manifest, "exports");
  if (exports !== undefined && exports !== null) return importTarget(subpathMap(exports)["."]);
  const main = prop(manifest, "main");
  return typeof main === "string" && main.length > 0 ? inside(main) : null;
}

/** An `exports` field as its subpath map: a target or a map of conditions alone is the package's `"."`. */
function subpathMap(exports: unknown): Record<string, unknown> {
  const subpaths =
    typeof exports === "object" &&
    exports !== null &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."));
  return subpaths ? (exports as Record<string, unknown>) : { ".": exports };
}

/** Where one subpath leads through `exports`: the file, and for a pattern, the directory it expands under. */
export interface ExportedTarget {
  /** The file an import takes, as a path inside the package. */
  target: string;
  /**
   * For a target reached through a pattern (`./src/*` → `./dist/*.js`), the directory inside the package
   * its `*` expands under (`dist`; `""` for the package itself). Absent for a subpath with a key of its own.
   */
  under?: string;
}

/**
 * What an import of `subpath` (`"."`, `"./src/capability"`) takes from a manifest's `exports`, as Node and
 * Vite resolve it: an exact key first, then the pattern with the longest prefix, each target followed
 * through the conditions an import matches. `null` when the map does not export it — no key, no pattern,
 * or a `null` target — and `undefined` when the manifest has no `exports`, so the subpath is a file path.
 */
export function exportedTarget(manifest: unknown, subpath: string): ExportedTarget | null | undefined {
  const exports = prop(manifest, "exports");
  if (exports === undefined || exports === null) return undefined;
  const map = subpathMap(exports);
  if (Object.hasOwn(map, subpath) && !subpath.includes("*")) {
    const target = importTarget(map[subpath]);
    return target === null ? null : { target };
  }
  let best: { key: string; star: string } | undefined;
  for (const key of Object.keys(map)) {
    const at = key.indexOf("*");
    if (at === -1 || key.indexOf("*", at + 1) !== -1) continue;
    const prefix = key.slice(0, at);
    const suffix = key.slice(at + 1);
    if (!subpath.startsWith(prefix) || subpath === prefix) continue;
    if (!subpath.endsWith(suffix) || subpath.length < key.length) continue;
    // Node's PATTERN_KEY_COMPARE: the longer prefix wins, and then the longer key.
    if (best !== undefined) {
      const held = best.key.indexOf("*");
      if (at < held || (at === held && key.length <= best.key.length)) continue;
    }
    best = { key, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  if (best === undefined) return null;
  const pattern = importTarget(map[best.key]);
  if (pattern === null) return null;
  return { target: pattern.replaceAll("*", best.star), under: patternBase(pattern) };
}

/**
 * The import that reaches `file` — a path inside the package, the one Node reports — through `exports`:
 * the key that maps to it, or the pattern whose `*` it fills. Only an answer that resolves back to `file`
 * through {@link exportedTarget} counts, so a pattern a longer one shadows never names the import.
 */
function exportedSubpath(manifest: unknown, file: string): (ExportedTarget & { subpath: string }) | undefined {
  const exports = prop(manifest, "exports");
  if (exports === undefined || exports === null) return undefined;
  for (const [key, value] of Object.entries(subpathMap(exports))) {
    const target = importTarget(value);
    if (target === null) continue;
    let subpath: string | undefined;
    const at = target.indexOf("*");
    if (!key.includes("*")) subpath = target === file ? key : undefined;
    else if (at !== -1) {
      const prefix = target.slice(0, at);
      const suffix = target.slice(at + 1).split("*")[0] ?? "";
      if (file.startsWith(prefix) && file.endsWith(suffix) && file.length > prefix.length + suffix.length) {
        subpath = key.replace("*", file.slice(prefix.length, file.length - suffix.length));
      }
    }
    const back = subpath === undefined ? undefined : exportedTarget(manifest, subpath);
    if (subpath !== undefined && back?.target === file) return { ...back, subpath };
  }
  return undefined;
}

/** The directory inside the package a pattern target's `*` expands under: `dist/*.js` → `dist`. */
function patternBase(pattern: string): string {
  const head = pattern.slice(0, pattern.indexOf("*"));
  return head.slice(0, Math.max(head.lastIndexOf("/"), 0));
}

/**
 * **A target the manifest declares and the disk does not have: the package unbuilt, or the import mistyped.**
 *
 * A key of its own is the package's word that the file exists, so its absence is the package's — unbuilt,
 * or a broken install. A pattern says nothing of the sort: `./src/*` matches `./src/capabilty` as readily as
 * `./src/capability`. What tells them apart is the directory the pattern expands under. With `dist` absent
 * the package was never built, and every import of it fails the same way whatever was typed; with `dist`
 * there, the build ran and this file is not in it, so the import names a path the package does not have.
 * A file deleted from a built `dist` reads as the second, and its remedy — check the version you have —
 * still leads to a reinstall.
 */
function exportedKind(found: ExportedTarget, installed: InstalledPackage): "package-entry" | "package-subpath" {
  if (found.under === undefined) return "package-entry";
  return installed.has(found.under) ? "package-subpath" : "package-entry";
}

/** One `exports` target, followed through conditions and fallbacks to the path an import takes. */
function importTarget(target: unknown): string | null {
  if (typeof target === "string") return inside(target);
  if (Array.isArray(target)) {
    for (const option of target) {
      const found = importTarget(option);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof target !== "object" || target === null) return null;
  for (const [condition, value] of Object.entries(target)) {
    if (!IMPORT_CONDITIONS.has(condition)) continue;
    const found = importTarget(value);
    if (found !== null) return found;
  }
  return null;
}

/** A manifest's path, as a path inside the package: no `./`, no trailing slash. */
function inside(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Every code a runtime throws for a module it could not find, or would not load as a module. */
const CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_UNKNOWN_BUILTIN_MODULE",
  "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  "ERR_RESOLVE_PACKAGE_ENTRY_FAIL",
]);

/** The same, said in prose by something that sets no code: Vite's module runner, and older loaders. */
const SENTENCE =
  /Cannot find (?:package|module) |Failed to resolve (?:import|module)|Failed to load url |No such built-in module: |is not defined by "exports"|No "exports" main defined in |Package import specifier |is not exported under the conditions |Failed to resolve entry for package /;

/**
 * Classify an import that would not resolve, or answer `undefined` when `cause` is not one.
 *
 * Read duck-typed, for `prop`'s reason in `cause.ts`, and through Bun's `AggregateError` wrapper, for
 * `rootCause`'s.
 */
export function unresolvedImport(
  wrapped: unknown,
  options: UnresolvedImportOptions = {},
): UnresolvedImport | undefined {
  const cause = rootCause(wrapped);
  if (!isUnresolved(cause)) return undefined;
  const referrer = importerPath(cause);
  const owner = ownerOf(referrer, options.loader);
  const found = locate(cause, referrer, options);
  const installHelps = found.kind === "package" || found.kind === "undetermined" || found.kind === "unnamed";
  return { ...found, ...(owner === undefined ? {} : { owner }), installHelps, remedy: remedy(found, owner) };
}

/**
 * The package whose own source holds the import that did not resolve — **never a path**.
 *
 * #480 is why: `pithy add email` refused with *Nothing resolves "@pithy-sh/core/src/capability/capability"*
 * while core resolved throughout, because the import was `@pithy-sh/email`'s and email was the package
 * not linked. The importer is the half that points there. The **last** `node_modules` in the path wins,
 * because every store nests (pnpm's `.pnpm/<id>/node_modules/<pkg>`, Bun's `.bun/<pkg>@<v>/node_modules/<pkg>`),
 * and the name is held to what npm allows, so a store's bookkeeping directory answers nothing.
 */
export function importingPackage(cause: unknown): string | undefined {
  return ownerOf(importerPath(cause), undefined);
}

function isUnresolved(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const code = prop(cause, "code");
  if (typeof code === "string" && CODES.has(code)) return true;
  if (prop(cause, "name") === "ResolveMessage") return true;
  return SENTENCE.test(causeMessage(cause) ?? "");
}

/** What {@link locate} decides: everything but the owner and the sentence. */
interface Located {
  kind: UnresolvedImportKind;
  shown?: string;
  package?: string;
}

/** A specifier that opens with a URL scheme: `node:`, `bun:`, `data:`. A Windows drive letter is one letter. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/** An absolute path: POSIX, a Windows drive, or a UNC share. */
const ABSOLUTE = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;

function locate(cause: unknown, referrer: string | undefined, options: UnresolvedImportOptions): Located {
  const code = prop(cause, "code");
  const message = causeMessage(cause) ?? "";

  // Node refuses a scheme it has no loader for before it resolves anything, and names only the scheme.
  if (code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") {
    const scheme = /Received protocol '([a-z][a-z0-9+.-]*:)'/i.exec(message)?.[1];
    return scheme === undefined ? { kind: "builtin" } : { kind: "builtin", shown: scheme };
  }
  if (
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    /is not defined by "exports"|No "exports" main defined in |is not exported under the conditions /.test(message)
  ) {
    return unexported(cause, message);
  }
  // Vite's runner, for a bare name it found installed and could load nothing for. It names the package and
  // no importer, so the manifest is asked from the project; a package that declares nothing has no entry.
  const unloadable = /Failed to resolve entry for package "([^"]+)"/.exec(message)?.[1];
  if (unloadable !== undefined) {
    const from = referrer ?? (options.relativeTo === undefined ? undefined : `${options.relativeTo}/package.json`);
    const declared = from === undefined ? undefined : declaredBy(options, unloadable, from);
    return { kind: declared === null ? "package-subpath" : "package-entry", package: unloadable, shown: unloadable };
  }

  const specifier = writtenSpecifier(cause, message);
  if (specifier === undefined) return { kind: "unnamed" };
  if (code === "ERR_UNKNOWN_BUILTIN_MODULE") return { kind: "builtin", shown: specifier };
  if (specifier.startsWith("#")) return { kind: "imports-map", shown: specifier };
  if (specifier.startsWith("file:")) return atPath(urlPath(specifier), referrer, options);
  // `node:nope`: the runtime provides these, so no install will. Never a package by its name.
  if (URL_SCHEME.test(specifier)) return { kind: "builtin", shown: specifier };

  // Node states the path it resolved to. That is the fact, whatever the import was written as.
  const url = prop(cause, "url");
  if (typeof url === "string" && url.startsWith("file:")) return atPath(urlPath(url), referrer, options);

  if (specifier.startsWith(".")) {
    if (referrer === undefined) return { kind: "local-file", shown: specifier };
    return atPath(joinPath(parentOf(referrer), specifier), referrer, options, specifier);
  }
  if (ABSOLUTE.test(specifier)) {
    // Node's sentence for a bare import of a package with no `exports`: the *package* could not be found,
    // at the path its `main` points to — or `index.js`, when it names none. What was imported was the
    // package's bare name, and whether it declared that path is the manifest's to say.
    const entry = /^Cannot find package '/.test(message) ? packageAt(specifier) : undefined;
    if (entry !== undefined) {
      const declared = declaredBy(options, entry.name, `${entry.dir}/package.json`);
      return { kind: declared === null ? "package-subpath" : "package-entry", package: entry.name, shown: entry.name };
    }
    return atPath(specifier, referrer, options);
  }

  // A bare name is the package itself, and Bun says the same of one installed with no entry as of one
  // absent. With no probe, it is taken as absent; with a path after it and no probe, nothing can say.
  const pkg = packageOf(specifier);
  const bare = pkg === specifier;
  if (options.installed === undefined || referrer === undefined) {
    return bare
      ? { kind: "package", package: pkg, shown: pkg }
      : { kind: "undetermined", package: pkg, shown: specifier };
  }
  if (!options.installed(pkg, referrer)) return { kind: "package", package: pkg, shown: pkg };
  // Installed, and Bun and Vite say no more. The manifest says whether the import was declared: by its bare
  // name, an entry; by a path, a key or a pattern in `exports` — and then whether its file was built.
  const installed = options.entry?.(pkg, referrer);
  if (bare) {
    const declared = installed === undefined ? undefined : declaredEntry(installed.manifest);
    return typeof declared === "string"
      ? { kind: "package-entry", package: pkg, shown: pkg }
      : { kind: "package-subpath", package: pkg, shown: specifier };
  }
  const exported =
    installed === undefined ? undefined : exportedTarget(installed.manifest, `./${specifier.slice(pkg.length + 1)}`);
  return installed !== undefined && exported !== undefined && exported !== null
    ? { kind: exportedKind(exported, installed), package: pkg, shown: specifier }
    : { kind: "package-subpath", package: pkg, shown: specifier };
}

/**
 * An installed package that does not export the path. The loader's field is the import as written where
 * there is one; Node's sentence names the subpath and the package's `package.json`, from which the
 * package — never the path — is taken. An `exports` map with no `"."` is the bare name unexported, and
 * Node's sentence for it names only the `package.json`.
 */
function unexported(cause: unknown, message: string): Located {
  const field = prop(cause, "specifier");
  if (typeof field === "string" && field.length > 0 && !ABSOLUTE.test(field) && !field.startsWith(".")) {
    return { kind: "package-subpath", package: packageOf(field), shown: field };
  }
  const main = /No "exports" main defined in (.+?)[\\/]package\.json/.exec(message)?.[1];
  const entry = main === undefined ? undefined : packageAt(`${main}/package.json`);
  if (entry !== undefined) return { kind: "package-subpath", package: entry.name, shown: entry.name };
  const match =
    /Package subpath '([^']+)' is not defined by "exports" in (.+?)[\\/]package\.json/.exec(message) ??
    /"([^"]+)" is not exported under the conditions \[[^\]]*\] from package (.+?) \(see exports field/.exec(message);
  const at = match?.[2] === undefined ? undefined : packageAt(`${match[2]}/package.json`);
  if (match?.[1] === undefined || at === undefined) return { kind: "package-subpath" };
  const subpath = match[1].replace(/^\.\/?/, "");
  return { kind: "package-subpath", package: at.name, shown: subpath === "" ? at.name : `${at.name}/${subpath}` };
}

/**
 * A path that did not resolve, from either runtime: inside an installed package, or in the adopter's tree.
 *
 * Inside a package, it is that package's own missing file when the import was written in the same package,
 * and a path the package does not have when anything else asked for it. In the adopter's tree, it is shown
 * relative to the project, or as the relative import it was written as, or not at all.
 */
function atPath(
  path: string,
  referrer: string | undefined,
  options: UnresolvedImportOptions,
  written?: string,
): Located {
  const inPackage = packageAt(path);
  if (inPackage !== undefined) {
    const shown = inPackage.rest === "" ? inPackage.name : `${inPackage.name}/${inPackage.rest}`;
    const own = referrer !== undefined && packageAt(referrer)?.name === inPackage.name;
    if (own) return { kind: "package-file", package: inPackage.name, shown };
    // Node resolves an import through `exports` and reports the file it landed on, so the path is the
    // package's declared entry when the manifest names it — and the import was the bare name, not this.
    const installed = options.entry?.(inPackage.name, `${inPackage.dir}/package.json`);
    const declared = installed === undefined ? undefined : declaredEntry(installed.manifest);
    if (typeof declared === "string" && isEntry(inPackage.rest, declared)) {
      return { kind: "package-entry", package: inPackage.name, shown: inPackage.name };
    }
    // Or a deep import an `exports` key or pattern led there: shown as it was written, never as the file.
    const written = installed === undefined ? undefined : exportedSubpath(installed.manifest, inPackage.rest);
    if (installed !== undefined && written !== undefined) {
      const subpath = written.subpath.replace(/^\.\/?/, "");
      const as = subpath === "" ? inPackage.name : `${inPackage.name}/${subpath}`;
      return { kind: exportedKind(written, installed), package: inPackage.name, shown: as };
    }
    return { kind: "package-subpath", package: inPackage.name, shown };
  }
  const { relativeTo } = options;
  const shown = (relativeTo === undefined ? undefined : within(path, relativeTo)) ?? written;
  return shown === undefined ? { kind: "local-file" } : { kind: "local-file", shown };
}

/** A package name as npm allows one: an optional `@scope/`, and never a store's dot-directory. */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/**
 * The package a path sits in, by the last `node_modules` in it: its name, its directory, and the path
 * inside it. The directory is for reading its manifest and never leaves this module.
 */
function packageAt(path: string): { name: string; dir: string; rest: string } | undefined {
  const segments = path.split(/[\\/]/);
  const at = segments.lastIndexOf("node_modules");
  if (at === -1) return undefined;
  const tail = segments.slice(at + 1);
  const name = packageOf(tail.join("/"));
  if (!PACKAGE_NAME.test(name)) return undefined;
  const depth = name.split("/").length;
  return {
    name,
    dir: segments.slice(0, at + 1 + depth).join("/"),
    rest: tail.slice(depth).join("/"),
  };
}

/**
 * Whether a path inside a package is the entry it declares, or that entry with the `.js` or `/index.js` a
 * `main` is tried with. Exact, so a deep import beneath a directory `main` is never read as the entry.
 */
function isEntry(rest: string, declared: string): boolean {
  return rest === declared || rest === `${declared}.js` || rest === `${declared}/index.js`;
}

/** The importing package, unless it is the loader's own frame. */
function ownerOf(referrer: string | undefined, loader: string | undefined): string | undefined {
  const name = referrer === undefined ? undefined : packageAt(referrer)?.name;
  return name === loader ? undefined : name;
}

/** `path` as `./…` beneath `root`, or `undefined` when it is not beneath it. Separators are shown as `/`. */
function within(path: string, root: string): string | undefined {
  const target = path.replaceAll("\\", "/");
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  if (target === base) return ".";
  return target.startsWith(`${base}/`) ? `./${target.slice(base.length + 1)}` : undefined;
}

/** The directory a path is in. A root is its own parent, which is what ends a walk. */
function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (at < 0) return path;
  if (at === 0) return path.slice(0, 1);
  const head = trimmed.slice(0, at);
  return /^[A-Za-z]:$/.test(head) ? `${head}${trimmed[at]}` : head;
}

/** A relative import, followed from the directory it was written in. `..` past the root stays at the root. */
function joinPath(base: string, relative: string): string {
  const separator = base.includes("/") ? "/" : "\\";
  const parts = base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const part of relative.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join(separator) || separator;
}

/** The path a `file:` URL names, or the URL with its scheme taken off when it will not parse as one. */
function urlPath(specifier: string): string {
  try {
    const path = decodeURIComponent(new URL(specifier).pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return specifier.replace(/^file:\/*/, "/");
  }
}

/**
 * The import that did not resolve, as the runtime named it. Bun's field where there is one; otherwise the
 * one sentence each loader states it in. The prose around it names the referrer's absolute path, which
 * is why only the quoted part is taken.
 */
function writtenSpecifier(cause: unknown, message: string): string | undefined {
  const field = prop(cause, "specifier");
  if (typeof field === "string" && field.length > 0) return field;
  const match =
    /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message) ??
    /^Failed to load url (\S+) \(resolved id: /.exec(message) ??
    /^No such built-in module: (\S+)$/.exec(message) ??
    /^Package import specifier "([^"]+)" is not defined/.exec(message) ??
    /^Directory import '([^']+)' is not supported/.exec(message);
  return match?.[1];
}

/**
 * The file the failing import was written in, as the runtime named it. **Module-private on purpose**: it
 * is an absolute path, and only its package half ever leaves here.
 *
 * Node ends its sentence with the path, so it is taken to the end — a directory may contain a space.
 * Vite's module runner quotes it, and its own `ERR_LOAD_URL` sentence names it before `. Does the file
 * exist?` (Vite 8.3.0, measured).
 */
function importerPath(cause: unknown): string | undefined {
  const field = prop(cause, "referrer");
  if (typeof field === "string" && field.length > 0) return field;
  const message = causeMessage(cause) ?? "";
  const match =
    / imported from '(.+)'$/.exec(message) ??
    / imported from (.+)$/.exec(message) ??
    /^Failed to load url \S+ \(resolved id: [^)]*\) in (.+)\. Does the file exist\?$/.exec(message);
  return match?.[1];
}

/** Every remedy that cannot be helped by an install says so, in these words. */
const NO_INSTALL = "installing dependencies will not help.";

/** The one sentence for a classified import. Built only from fields that cannot carry a path. */
function remedy(found: Located, owner: string | undefined): string {
  const { kind, shown, package: pkg } = found;
  switch (kind) {
    case "package": {
      const name = pkg ?? shown ?? "a package";
      return owner === undefined
        ? `"${name}" is not installed. Install the project's dependencies (bun install), or correct that import.`
        : `${owner} imports "${name}", which is not installed. Install the project's dependencies (bun install). If it is still missing, ${owner} does not declare it — report that to its maintainer.`;
    }
    case "package-subpath":
      if (shown === undefined || pkg === undefined) {
        return `An import asks an installed package for a path it does not provide. Check the version you have, or correct that import — ${NO_INSTALL}`;
      }
      if (shown === pkg && (owner === undefined || owner === pkg)) {
        return `The installed ${pkg} has no entry to import by its bare name. Import one of its paths, or check the version of ${pkg} you have — ${NO_INSTALL}`;
      }
      return owner === undefined || owner === pkg
        ? `"${shown}" is not something the installed ${pkg} provides. Check the version of ${pkg} you have, or correct that import — ${NO_INSTALL}`
        : `${owner} imports "${shown}", which the installed ${pkg} does not provide. Bring ${owner} and ${pkg} to matching versions, or report this to its maintainer — ${NO_INSTALL}`;
    case "package-entry": {
      const fix = `so it is unbuilt or its install is broken. Rebuild ${pkg}, or remove it and install it again.`;
      // A deep import is named as it was written: the path its `exports` maps it to is never shown.
      const deep = shown !== undefined && shown !== pkg;
      const missing = deep
        ? `exports "${shown}" from a file that is not there, ${fix}`
        : `names an entry that is not there, ${fix}`;
      if (owner === undefined || owner === pkg) return `The installed ${pkg} ${missing}`;
      return deep
        ? `${owner} imports "${shown}", and the installed ${pkg} exports it from a file that is not there, ${fix}`
        : `${owner} imports "${pkg}", and the installed ${pkg} ${missing}`;
    }
    case "package-file":
      return `${pkg} is missing its own file "${shown}". Report this to its maintainer — ${NO_INSTALL}`;
    case "builtin":
      if (shown === undefined)
        return `An import names a module this runtime does not provide. Correct that import — ${NO_INSTALL}`;
      return owner === undefined
        ? `"${shown}" is not a module this runtime provides. Correct that import — ${NO_INSTALL}`
        : `${owner} imports "${shown}", which this runtime does not provide. Run it on a runtime that has that module, or report this to its maintainer — ${NO_INSTALL}`;
    case "local-file":
      return shown === undefined
        ? `An import names a file that is not there. Create that file or correct the import — ${NO_INSTALL}`
        : `Nothing at "${shown}". Create that file or correct the import — ${NO_INSTALL}`;
    case "imports-map":
      return owner === undefined
        ? `"${shown}" is not in the project's imports map. Add it to the imports field of package.json, or correct the import — ${NO_INSTALL}`
        : `${owner} imports "${shown}", which its own imports map does not provide. Report this to its maintainer — ${NO_INSTALL}`;
    case "undetermined":
      return owner === undefined
        ? `Nothing resolves "${shown}". Install the project's dependencies (bun install), or correct that import.`
        : `${owner} imports "${shown}", and nothing resolves it. Install the project's dependencies (bun install), or bring ${owner} and ${pkg} to matching versions.`;
    case "unnamed":
      return "An import does not resolve. Check the imports, then install the project's dependencies (bun install).";
  }
}

/** A package's file that would not load: the package it is in, and the one sentence for it. */
export interface PackageLoadFailure {
  /** The installed package whose own file threw. Never the loader. */
  owner: string;
  /** The one sentence every surface puts in its `action`. Names the package, never a path. */
  remedy: string;
}

/** What Node says of code whose syntax contradicts the module type its package declares. */
const MODULE_TYPE =
  / is not defined in ES module scope|Cannot use import statement outside a module|Unexpected token 'export'|Cannot use 'import\.meta' outside a module/;

/**
 * **A file inside an installed package would not load, so the package is named and never the config.**
 *
 * A `"type"` its code contradicts — `module` over `module.exports`, `commonjs` over `import` — throws from
 * inside that package, on Node and through Vite's runner alike, as a `ReferenceError` or a `SyntaxError`.
 * Unclassified, the first read as *the config threw while loading* and the second as *the config does not
 * parse*: the adopter told to fix a file that is fine. A package's file that does not parse at all is the
 * same fault in the same place, and is named the same way.
 *
 * **The file is the one that failed to load, and only that one.** Node heads a compile error with the file
 * and line it could not compile, and Bun 1.4.2 hands over a `BuildMessage` with no stack at all, the file
 * in its `position`. Otherwise the error's first stack frame must be a module's own top level, run as it
 * is imported — `at file:///…:L:C`, or Vite's `at eval (…)`, with no function of its own. A first frame
 * inside a function is the config calling into a package, and a later frame is a caller: so a package's
 * deliberate throw, which the config provoked — json5's `parse` throws a `SyntaxError` on bad input — is
 * never laid at the package's door. Only errors a module throws while it is loaded are read: a
 * `SyntaxError` or a `BuildMessage`, and a `ReferenceError` for a CommonJS global in a module's scope.
 *
 * `undefined` when the cause is not one, or was thrown in the adopter's own file — that stays theirs.
 */
export function packageLoadFailure(
  wrapped: unknown,
  options: Pick<UnresolvedImportOptions, "loader"> = {},
): PackageLoadFailure | undefined {
  const cause = rootCause(wrapped);
  const typeMismatch = MODULE_TYPE.test(causeMessage(cause) ?? "");
  const name = prop(cause, "name");
  if (!typeMismatch && name !== "SyntaxError" && name !== "BuildMessage") return undefined;
  const owner = ownerOf(failedToLoad(cause), options.loader);
  if (owner === undefined) return undefined;
  const check = `Check the version of ${owner} you have, or report this to its maintainer — ${NO_INSTALL}`;
  return {
    owner,
    remedy: typeMismatch
      ? `The installed ${owner} does not load as the module type its package.json declares. ${check}`
      : `The installed ${owner} does not parse. ${check}`,
  };
}

/**
 * The file that failed as it loaded, or none: the file and line Node heads a compile error with, the file a
 * stackless `BuildMessage` names in its `position` (Bun 1.4.2), or a first frame at a module's top level.
 * Never a frame inside a function, which is code running after its module loaded. **Module-private**, like
 * {@link importerPath}: it is an absolute path.
 */
function failedToLoad(cause: unknown): string | undefined {
  const stack = prop(cause, "stack");
  if (typeof stack !== "string") {
    const file = prop(prop(cause, "position"), "file");
    return typeof file === "string" ? locationPath(file) : undefined;
  }
  const lines = stack.split("\n");
  const head = /^(.+):\d+$/.exec(lines[0] ?? "")?.[1];
  if (head !== undefined && (head.startsWith("file:") || ABSOLUTE.test(head))) return locationPath(head);
  const frame = lines.find((line) => /^\s+at /.test(line));
  if (frame === undefined) return undefined;
  // A module's top level: no function at all, or the `eval` Vite's runner evaluates a module in.
  const at =
    /^\s+at eval \((.+?):\d+(?::\d+)?\)$/.exec(frame)?.[1] ?? /^\s+at ([^()]+?):\d+(?::\d+)?$/.exec(frame)?.[1];
  return at === undefined ? undefined : locationPath(at);
}

/** A stack location as a path: a `file:` URL converted, an absolute path kept, anything else — `node:` — none. */
function locationPath(location: string): string | undefined {
  if (location.startsWith("file:")) return urlPath(location);
  return ABSOLUTE.test(location) ? location : undefined;
}
