// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { promoteDependencies } from "../project/packageManager";
import { readOptionalFile } from "../project/readOptionalFile";
import { ensureScaffoldPath, pathExists } from "../project/scaffold";
import { workerEntryPath } from "../project/wrangler";
import {
  capabilityImportSpecifier,
  findNamedImport,
  importedSpecifiers,
  isCapabilityImport,
  isInside,
  namedReexports,
} from "./configImports";

/**
 * The directory an ejected capability's source is copied into, relative to the Worker's
 * `pithy.config.ts` — so it lands in `apps/<worker>/capabilities/<cap>/`, beside the config that
 * imports it. Ejecting is per-Worker because the wiring it forks is per-Worker.
 */
export const EJECT_DIR = "capabilities";

/**
 * The local import path an ejected capability is wired to, **from the Worker's own directory** — also the
 * "this is ejected" signal for upgrade, which reads `pithy.config.ts` and nothing else.
 *
 * Every other file is a different distance from the fork, so a file that is not the config asks
 * {@link ejectSpecifierFromDir} instead.
 */
export function ejectImportPath(capability: string): string {
  return `./${EJECT_DIR}/${capability}`;
}

/**
 * The fork's specifier **as written into a file in `fromDir`** — `./capabilities/<cap>` from the Worker's
 * own directory, `../capabilities/<cap>` from the `src/` the entry usually sits in.
 *
 * A specifier is resolved relative to the file holding it, and eject writes one into two files at two
 * depths: `apps/<worker>/pithy.config.ts` and whatever module that Worker's `main` names. Reusing the
 * config's spelling in the entry produced `./capabilities/<cap>` resolved from `apps/<worker>/src/`,
 * which is nowhere — a Worker that stopped bundling, written by the command whose job is that it still
 * does. So each writer derives its own path from the file it is writing into.
 *
 * POSIX separators whatever the platform's are: this is a module specifier, not a filesystem path, and a
 * bundler reads `\` as an escape.
 */
export function ejectSpecifierFromDir(workerDir: string, fromDir: string, capability: string): string {
  const path = relative(fromDir, join(workerDir, EJECT_DIR, capability))
    .split(sep)
    .join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * The capabilities a `pithy.config.ts` source has ejected — those imported from the local
 * `./capabilities/<name>` path rather than an `@pithy-sh/*` package. The local import **is** the
 * ejected signal: a future `pithy upgrade` reads this to skip forks (issue #33), since ejected code
 * no longer tracks the package.
 */
export function parseEjectedCapabilities(configSource: string): string[] {
  const names: string[] = [];
  for (const specifier of importedSpecifiers(configSource)) {
    const name = ejectedCapabilityName(specifier);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The capability a specifier forks, or `undefined` when it does not point into the fork directory.
 *
 * Decided by {@link isInside} — the same call `importOrigin` makes — because these two functions
 * answer one question and used to answer it differently: a regex here accepted
 * `./capabilities/<name>/<anything>` while `isCapabilityImport` demanded exact equality, so a config
 * read as ejected while the import that made it so was refused as not the capability's. The regex also
 * captured `..` as a capability name, off a path leaving the directory entirely.
 */
function ejectedCapabilityName(specifier: string): string | undefined {
  const prefix = `./${EJECT_DIR}/`;
  if (!specifier.startsWith(prefix)) return undefined;
  const name = specifier.slice(prefix.length).split("/")[0];
  if (!name || name === "." || name === "..") return undefined;
  return isInside(specifier, ejectImportPath(name)) ? name : undefined;
}

/**
 * Read a Worker's `pithy.config.ts` and return the ejected capability names (empty if the file is
 * unreadable). `workerDir` is `apps/<name>` — the config that wires the capability is the one that says
 * whether it was forked.
 */
export async function ejectedCapabilities(workerDir: string): Promise<string[]> {
  try {
    return parseEjectedCapabilities(await readFile(join(workerDir, "pithy.config.ts"), "utf8"));
  } catch {
    return [];
  }
}

/** Whether a specific capability has been ejected in this Worker. */
export async function isEjected(workerDir: string, capability: string): Promise<boolean> {
  return (await ejectedCapabilities(workerDir)).includes(capability);
}

/** Promote a forked capability's runtime deps into the project. Injected in tests. */
export type PromoteDeps = (projectDir: string, deps: string[]) => Promise<void>;

export interface EjectCapabilityOptions {
  /** The project root — where `package.json`, the lockfile, and `node_modules` live. */
  projectDir: string;
  /** The Worker's directory (`apps/<name>`) — its `pithy.config.ts`, and where the fork lands. */
  workerDir: string;
  /** The capability's short name, e.g. `auth` — the local directory and import leaf. */
  capability: string;
  /** The capability's package, e.g. `@pithy-sh/auth` — the source and manifest to read. */
  package: string;
  /** Overwrite an existing local copy, discarding the user's edits. Off by default (refuses). */
  force?: boolean;
  /** Promote the package's runtime deps; defaults to the detected package manager. */
  promoteDeps?: PromoteDeps;
}

/** What eject did: where the source landed and which deps it promoted. */
export interface EjectResult {
  capability: string;
  /** The Worker-relative directory the source was copied into (`capabilities/<cap>`). */
  path: string;
  /** The `name@version` deps promoted into the project (workspace-internal ones excluded). */
  promotedDependencies: string[];
  /** Whether an existing local copy was overwritten (`--force`). */
  forced: boolean;
}

/**
 * The package's promotable runtime dependencies as `name@version`, read from the installed manifest.
 * Workspace-internal versions (`workspace:*`) are dropped — they exist only inside this monorepo and a
 * published package never carries them; an adopter's install resolves them to real ranges.
 */
async function promotableDependencies(projectDir: string, pkg: string): Promise<string[]> {
  // Absent and corrupt are both answered by reinstalling; a mode bit and a directory are not, and one
  // `try` around the read and the parse said *reinstall* to all four (#217). `readOptionalFile` owns the
  // errno that is not absence and hedges on it, which leaves each of the other three its own sentence.
  const path = join(projectDir, "node_modules", pkg, "package.json");
  const raw = await readOptionalFile(path);
  if (raw === null) {
    throw new InternalError({
      message: `${pkg} is not installed, so its dependencies cannot be promoted.`,
      action: `Reinstall ${pkg}, then eject again.`,
      detail: `No package.json at ${path}.`,
    });
  }

  let dependencies: Record<string, string>;
  try {
    dependencies = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch (cause) {
    throw new InternalError({
      message: `${pkg}'s package.json is not valid JSON, so its dependencies cannot be promoted.`,
      action: `Reinstall ${pkg}, then eject again.`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return Object.entries(dependencies)
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([name, version]) => `${name}@${version}`);
}

/**
 * Repoint the managed-region import from the package to the local copy; idempotent if already local.
 *
 * The import is found by its binding and repointed whatever path into the package it uses — the same
 * set `add` writes and `remove` takes out. Matching one exact specifier meant a hand-edited deep
 * import could not be ejected at all, and `pithy add` would not put the canonical line back, so there
 * was no way out through the CLI.
 */
async function repointImport(workerDir: string, pkg: string, capability: string): Promise<void> {
  const path = join(workerDir, "pithy.config.ts");
  const source = await readFile(path, "utf8");
  // Derived from the file being written, like the entry's is. For the config the answer is
  // `ejectImportPath` itself — it sits in the Worker's own directory — and that is the string
  // `parseEjectedCapabilities` reads back as the "this is ejected" signal.
  const local = ejectSpecifierFromDir(workerDir, dirname(path), capability);
  const found = findNamedImport(source, capability);
  if (found?.specifier === local) return; // already ejected — a --force re-copy leaves it local
  if (found && isCapabilityImport(found.specifier, pkg, local)) {
    // The specifier is the only quoted region in the statement, so swapping it there keeps whatever
    // spacing and quote style the adopter's config uses.
    const repointed = found.statement.replace(found.specifier, () => local);
    await writeFile(
      path,
      source.replace(found.statement, () => repointed),
    );
    return;
  }
  throw new NotFoundError({
    message: `${path} doesn't import ${pkg}.`,
    action: `Run pithy add ${capability} first, then eject.`,
  });
}

/**
 * The local path a specifier into the package becomes once the package's `src/` is a fork under
 * `capabilities/<cap>/`.
 *
 * The barrel becomes the fork directory itself — `local`, the fork as the file being written reaches it,
 * so the two halves of the wiring name one directory in each file's own spelling. Anything deeper under
 * `src/` keeps its path below it, because `cp` preserved the structure.
 *
 * Anything else inside the package is **refused, by name**. Only `src/` is copied, so there is no local
 * counterpart to point at, and quietly leaving the line alone would put the package's class back into the
 * bundle under the fork's name — which is the failure repointing exists to prevent.
 */
function localSpecifier(pkg: string, local: string, specifier: string): string {
  if (specifier === pkg || specifier === capabilityImportSpecifier(pkg)) return local;
  const src = `${pkg}/src/`;
  if (specifier.startsWith(src)) return `${local}/${specifier.slice(src.length)}`;
  throw new ConflictError({
    message: `The worker entry re-exports ${specifier}, which eject cannot fork — only ${pkg}/src is copied.`,
    action: `Point that export at a path under ${pkg}/src, or take the line out, then eject again.`,
  });
}

/**
 * The Worker entry with its re-exports of the package repointed at the local fork, or `null` when there
 * is nothing to change.
 *
 * **The other half of the wiring, and the half that decides which code actually runs.** `pithy add` writes
 * `export { <Class> } from "@pithy-sh/<cap>/…"` into the entry, because wrangler resolves a Durable
 * Object's `class_name` against the module `main` names (#428). Ejecting only `pithy.config.ts` left that
 * line pointing at the package: Cloudflare instantiated the package's class while the adopter edited the
 * copy, and nothing said so — it builds, it deploys, and every change to the forked actor is ignored.
 * `docs/EJECT.md` promised the project imports nothing from the package afterwards, and this is what makes
 * that sentence true rather than nearly true.
 *
 * Every re-export pointing into the package, not only the ones the CLI wrote. A line an adopter added by
 * hand reaches the same class through the same package, and `repointImport` follows whatever path into the
 * package a config uses for exactly this reason.
 *
 * A Worker whose config names no entry — a front end that joins the dev set through `pithy.worker.jsonc`
 * alone — has nothing to repoint and is not a failure.
 */
async function planEntryExports(
  workerDir: string,
  pkg: string,
  capability: string,
): Promise<{ path: string; written: string } | null> {
  const path = await workerEntryPath(workerDir).catch(() => null);
  const source = path === null ? null : await readOptionalFile(path);
  if (path === null || source === null) return null;

  // Relative to the entry, not to `pithy.config.ts`: the two files sit at different depths and the fork
  // is one directory. {@link ejectSpecifierFromDir} says what reusing the config's spelling here cost.
  const local = ejectSpecifierFromDir(workerDir, dirname(path), capability);
  // Planned as spans and applied last-first, so each splice lands where the scanner found it and no
  // earlier edit moves a later one. Found by offset because a commented-out copy of a line contains
  // that line verbatim, and a literal search repointed the comment while the live export kept naming
  // the package (#428). `namedReexports` yields in source order, so reversing gives descending starts.
  const edits: { start: number; end: number; text: string }[] = [];
  for (const { statement, specifier, start } of namedReexports(source)) {
    if (specifier !== pkg && !specifier.startsWith(`${pkg}/`)) continue;
    // The specifier is the only quoted region in the statement, so swapping it there keeps whatever
    // spacing and quote style the entry uses. Replacement functions keep any `$` in either string.
    const text = statement.replace(specifier, () => localSpecifier(pkg, local, specifier));
    edits.push({ start, end: start + statement.length, text });
  }
  if (edits.length === 0) return null;

  let written = source;
  for (const edit of edits.reverse()) {
    written = written.slice(0, edit.start) + edit.text + written.slice(edit.end);
  }
  return written === source ? null : { path, written };
}

/**
 * Eject a capability into **one Worker**: copy its entire installed `src/` into
 * `apps/<worker>/capabilities/<cap>/`, repoint that Worker's `pithy.config.ts` import at the local copy,
 * and promote the package's runtime deps into the project so the copy builds standalone. The capability
 * is now the user's — nothing from `@pithy-sh/<cap>` is imported and it no longer upgrades (the
 * principle-3 trade). Another Worker that wires the same capability keeps the package; a fork is scoped
 * to the Worker that asked for it. Refuses to overwrite an existing local copy unless `force` is set;
 * `force` removes it first so stale files don't linger.
 */
export async function ejectCapability(options: EjectCapabilityOptions): Promise<EjectResult> {
  const { projectDir, workerDir, capability, package: pkg, force } = options;
  const source = join(projectDir, "node_modules", pkg, "src");
  const dest = join(workerDir, EJECT_DIR, capability);

  if (!(await pathExists(source))) {
    throw new NotFoundError({
      message: `${pkg} is not installed (no ${pkg}/src to eject).`,
      action: `Run pithy add ${capability} first.`,
    });
  }

  // The fork's own path, and every segment of it Pithy composed: `apps`, `apps/<worker>`,
  // `capabilities`, `capabilities/<cap>`. This was a local `exists()` over `stat`, which follows a link
  // and answers about its destination — so a symlink at any of the four read as "not ejected yet" and the
  // `cp` below wrote the capability's whole source through it, outside the project. That is the fifth
  // producer of one escape, and it is the reason the question has exactly one implementation now.
  await ensureScaffoldPath(projectDir, dest);
  const alreadyEjected = await pathExists(dest);
  if (alreadyEjected && !force) {
    throw new ConflictError({
      message: `${EJECT_DIR}/${capability} already exists.`,
      action: "Edit the local copy, or re-run with --force to overwrite it (discards your changes).",
    });
  }
  if (alreadyEjected) await rm(dest, { recursive: true, force: true });

  // Order matters for a clean failure: copy the source, promote its deps, and only then repoint the
  // config. If promotion fails, the config still imports the working package rather than a local copy
  // whose dependencies were never installed.
  await cp(source, dest, { recursive: true });

  const promotedDependencies = await promotableDependencies(projectDir, pkg);
  const promote = options.promoteDeps ?? ((dir, deps) => promoteDependencies(dir, deps).then(() => {}));
  await promote(projectDir, promotedDependencies);

  // Planned before either write, and written after both: {@link localSpecifier} refuses a re-export it
  // cannot fork, and a refusal raised between the two would leave the config naming the fork while the
  // entry still named the package. Same reasoning as the copy/promote/repoint order above.
  const entry = await planEntryExports(workerDir, pkg, capability);
  await repointImport(workerDir, pkg, capability);
  if (entry) await writeFile(entry.path, entry.written);

  return { capability, path: `${EJECT_DIR}/${capability}`, promotedDependencies, forced: Boolean(alreadyEjected) };
}
