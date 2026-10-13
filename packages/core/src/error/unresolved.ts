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
   * Answers the next one: the entry an installed package declares. Without it, Bun's bare name is taken to
   * have no entry there, and a loader that names the file or the package it could not load — Node reaching
   * for a `main`, Vite's *Failed to resolve entry* — is taken to have reached for a declared one.
   */
  entry?: EntryProbe;
  /** The directory an adopter's paths are shown relative to. Without it, a resolved path is never shown. */
  relativeTo?: string;
  /** The package doing the importing — `@pithy-sh/cli`, `@pithy-sh/vite`. Never named as an owner. */
  loader?: string;
}

/**
 * The entry an installed `pkg` declares for an ESM import of its bare name, as a path inside the package
 * (`dist/index.js`, `lib`), found on the chain above `from`. `null` when it declares none — no `exports`
 * `"."` an import can use, and no `main` — and `undefined` when there is no such package, or no manifest
 * to read. {@link packageEntryProbe} builds the answer.
 */
export type EntryProbe = (pkg: string, from: string) => string | null | undefined;

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
 * The {@link EntryProbe} a surface on Node or Bun passes: the same walk as {@link nodeModulesProbe}, and
 * then the package's own `package.json`, read for the entry an `import` of its bare name would take.
 */
export function packageEntryProbe(fs: ProbeFileSystem & { read(path: string): string }): EntryProbe {
  return (pkg, from) => {
    const dir = installedAt(fs, pkg, from);
    if (dir === undefined) return undefined;
    try {
      return declaredEntry(JSON.parse(fs.read(`${dir}/package.json`)));
    } catch {
      return undefined;
    }
  };
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
  if (exports !== undefined && exports !== null) {
    const subpaths =
      typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."));
    return importTarget(subpaths ? prop(exports, ".") : exports);
  }
  const main = prop(manifest, "main");
  return typeof main === "string" && main.length > 0 ? inside(main) : null;
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
    const declared = from === undefined ? undefined : options.entry?.(unloadable, from);
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
      const declared = options.entry?.(entry.name, `${entry.dir}/package.json`);
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
  // Installed, and Bun says no more. By its bare name, the manifest says whether an entry was declared.
  const declared = bare ? options.entry?.(pkg, referrer) : undefined;
  return typeof declared === "string"
    ? { kind: "package-entry", package: pkg, shown: pkg }
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
    // Node resolves a bare name through `exports` and reports the file it landed on, so the path is the
    // package's declared entry when the manifest names it — and the import was the bare name, not this.
    const declared = options.entry?.(inPackage.name, `${inPackage.dir}/package.json`);
    if (typeof declared === "string" && isEntry(inPackage.rest, declared)) {
      return { kind: "package-entry", package: inPackage.name, shown: inPackage.name };
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
      const missing = `names an entry that is not there, so it is unbuilt or its install is broken. Rebuild ${pkg}, or remove it and install it again.`;
      return owner === undefined || owner === pkg
        ? `The installed ${pkg} ${missing}`
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
