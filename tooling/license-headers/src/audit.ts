// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { applyHeader, mentionsSpdx, readIdentifier } from "./header";
import { canonicalText } from "./licenses";
import { discoverPackages, sourceFiles } from "./workspace";

/**
 * One thing wrong with the repo's licensing.
 *
 * Every `path` is repo-relative and POSIX-separated, so a finding reads the same on every machine
 * and can be pasted straight into an editor.
 */
export type Finding =
  /** A manifest declares no `license` at all. */
  | { kind: "missing-license-field"; package: string }
  /** A manifest declares a licence we hold no canonical text for. */
  | { kind: "unknown-license"; package: string; license: string }
  /** A package ships no `LICENSE` file. */
  | { kind: "missing-license-file"; package: string; path: string }
  /** A `LICENSE` file's text is not the licence its manifest declares. */
  | { kind: "license-file-mismatch"; package: string; path: string }
  /** A source file carries no SPDX header. */
  | { kind: "missing-header"; path: string; expected: string; actual: null }
  /** A source file's header names a licence its package does not declare. */
  | { kind: "wrong-header"; path: string; expected: string; actual: string }
  /** A scaffolded template carries a header it must not have. */
  | { kind: "unexpected-header"; path: string };

/**
 * What a finding calls the repo root, which has no package name of its own.
 *
 * Named rather than written twice: `applyFixes` keys on it to know a licence has to come from the
 * root manifest instead of the package list, so the two spellings must never drift apart.
 */
const ROOT_NAME = "<root>";

/** Repo-relative, forward-slashed, so findings are stable across platforms. */
function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * Every licensing problem in the repo at `root`, in a stable order: the root first, then each
 * package by name, then the scaffolded template trees.
 *
 * The three layers are checked against each other rather than against a constant — a package's
 * `package.json` `license` is the single source of truth, and its `LICENSE` file and every header
 * under its `src` must agree with it.
 */
export function audit(root: string): Finding[] {
  const findings: Finding[] = [];

  findings.push(...auditUnit(root, root, ROOT_NAME, { headers: false, licenseFile: true }));

  for (const pkg of discoverPackages(root)) {
    // `tooling/*` is private and never published. A LICENSE file there would be one nobody can
    // receive — there is no tarball to put it in — so only the header requirement carries over.
    findings.push(...auditUnit(root, pkg.dir, pkg.name, { headers: true, licenseFile: pkg.group === "packages" }));
  }

  for (const file of templateFiles(root)) {
    if (mentionsSpdx(readFileSync(file, "utf8"))) {
      findings.push({ kind: "unexpected-header", path: rel(root, file) });
    }
  }

  return findings;
}

/** Check one manifest + its LICENSE, and — for a real package — every header under its `src`. */
function auditUnit(
  root: string,
  dir: string,
  name: string,
  options: { headers: boolean; licenseFile: boolean },
): Finding[] {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return [];

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { license?: string };
  const license = manifest.license;

  const expected = license === undefined ? null : canonicalText(license);

  const findings: Finding[] = [];
  if (license === undefined) findings.push({ kind: "missing-license-field", package: name });
  else if (expected === null) findings.push({ kind: "unknown-license", package: name, license });

  // Whether the file exists is true independently of what the manifest says, so it is reported
  // either way. Only comparing its *body* needs a known licence — reporting the two together is
  // what stops a bare package costing two fix-and-rerun rounds to diagnose.
  const licensePath = join(dir, "LICENSE");
  if (!existsSync(licensePath)) {
    if (options.licenseFile) {
      findings.push({ kind: "missing-license-file", package: name, path: rel(root, licensePath) });
    }
  } else if (expected !== null && readFileSync(licensePath, "utf8") !== expected) {
    // Checked even where one is not required: a LICENSE that exists has to be right regardless.
    findings.push({ kind: "license-file-mismatch", package: name, path: rel(root, licensePath) });
  }

  // Headers hang off the declared licence. With none resolved there is nothing to compare against,
  // and flagging all 60 files in a package as headerless would bury the one finding that matters.
  if (!options.headers || license === undefined || expected === null) return findings;

  for (const file of sourceFiles(dir)) {
    const actual = readIdentifier(readFileSync(file, "utf8"));
    if (actual === null) {
      findings.push({ kind: "missing-header", path: rel(root, file), expected: license, actual: null });
    } else if (actual !== license) {
      findings.push({ kind: "wrong-header", path: rel(root, file), expected: license, actual });
    }
  }

  return findings;
}

/** Directories that never hold first-party source. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", ".worktrees"]);

/**
 * Every file inside a `templates/` tree — the root starter and each package's own.
 *
 * These are copied verbatim into the adopter's repo, so they are checked for the *absence* of a
 * header. Any depth, any extension: a stamped `.tsx` screen and a stamped `.ts` config are the
 * same mistake.
 *
 * **Any name, too — a dotted directory is entered.** That is the one way this walk has to differ from
 * `packages/cli/src/ci/sourceFiles.ts`, which skips one unless a caller opts in (#215). The rule there
 * keeps `.smoke-*`, `.e2e-*` and `.worktrees/` out of every tripwire in that repository; the question
 * here is not about that tree's source but about what a template *ships*, and a `.vscode/`, a `.husky/`
 * or a `.github/` inside one is copied into the adopter's repo file for file like everything beside it.
 * No template holds a dotted directory today, which is why `audit.test.ts` plants one: a gate whose
 * reach is narrower than the rule it enforces reports clean and says nothing.
 *
 * `SKIP_DIRS` still names the four that never hold a template's own files, dotted or not.
 */
function templateFiles(root: string): string[] {
  const roots = [join(root, "templates")];
  for (const pkg of discoverPackages(root)) roots.push(join(pkg.dir, "templates"));

  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else {
        found.push(path);
      }
    }
  };
  for (const dir of roots) walk(dir);

  return found.sort();
}

/**
 * Repair what can be repaired safely, returning the repo-relative paths changed.
 *
 * Two repairs only: stamp or correct a source header, and write a `LICENSE` that is absent. A
 * `LICENSE` whose body has *drifted* is reported and left alone — an edit to legal text may well be
 * deliberate, and silently reverting it is the one thing this tool must never do.
 */
export function applyFixes(root: string): string[] {
  const changed: string[] = [];
  const packages = discoverPackages(root);

  for (const finding of audit(root)) {
    if (finding.kind === "missing-header" || finding.kind === "wrong-header") {
      const path = join(root, finding.path);
      const source = readFileSync(path, "utf8");
      writeFileSync(path, applyHeader(source, finding.expected));
      changed.push(finding.path);
    } else if (finding.kind === "missing-license-file") {
      const pkg = packages.find((p) => p.name === finding.package);
      const license = finding.package === ROOT_NAME ? rootLicense(root) : (pkg?.license ?? null);
      const text = license === null ? null : canonicalText(license);
      if (text !== null) {
        writeFileSync(join(root, finding.path), text);
        changed.push(finding.path);
      }
    }
  }

  return changed;
}

/**
 * Stamp just these files, returning the repo-relative paths changed.
 *
 * This is the lint-staged path. It exists because lint-staged re-stages only the files it passed to
 * the task: a repo-wide `--fix` would write correct headers and leave every one of them unstaged,
 * so the commit it was meant to protect would land headerless anyway.
 *
 * A path outside any package's `src` is skipped rather than refused — the staged set is whatever
 * the developer touched, not a curated list.
 *
 * That `src` requirement is also what excludes the scaffold trees, and it has to be the only thing
 * that does. Scaffolds live at `<root>/templates` and `<pkg>/templates`, never under a `src`, so the
 * owner lookup below already rules them out. Testing the path for a `templates` segment as well
 * looks like belt-and-braces and is actually a bug: `packages/email/src/templates/` is nine files of
 * real library source, and skipping it made this path disagree with {@link applyFixes} — the commit
 * hook would stamp nothing there while a repo-wide run stamped it, so CI failed on a file the hook
 * had just waved through.
 */
export function fixFiles(root: string, paths: string[]): string[] {
  const packages = discoverPackages(root);
  const changed: string[] = [];

  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : join(root, path);
    if (!existsSync(absolute)) continue;

    const owner = packages.find((pkg) => absolute.startsWith(join(pkg.dir, "src") + sep));
    if (owner?.license === undefined || owner.license === null) continue;
    if (canonicalText(owner.license) === null) continue;

    const source = readFileSync(absolute, "utf8");
    const stamped = applyHeader(source, owner.license);
    if (stamped === source) continue;

    writeFileSync(absolute, stamped);
    changed.push(rel(root, absolute));
  }

  return changed;
}

/** The licence the repo root itself declares, or `null` when its manifest omits one. */
function rootLicense(root: string): string | null {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { license?: string };
  return manifest.license ?? null;
}
