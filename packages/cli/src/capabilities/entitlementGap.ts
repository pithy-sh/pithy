// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";

/**
 * The entitlement composition check — the CLI half of the entitlement seam.
 *
 * The seam fails closed: with no provider composed, `c.var.entitlements` holds nothing and every
 * `requireEntitlement()` denies. That is the right runtime behaviour and the wrong developer
 * experience, because the runtime cannot tell the two cases apart. A legitimately unentitled user and
 * a Worker that forgot to compose `payments` produce the identical 403, so the second one ships,
 * paywalls every paid route shut, and is diagnosed from support tickets.
 *
 * So the mistake is caught where it is still cheap: `pithy doctor` and `pithy dev` compare the gates in
 * a Worker's own source against whether any capability it composes declares
 * {@link Capability.providesEntitlements}. Runtime denial stays the backstop; this is the check.
 *
 * The scan is textual, and deliberately so. Loading a Worker's routes to inspect them would execute
 * adopter code during a health check, and the question is not subtle enough to need a parser: a call to
 * one of two named helpers, in the Worker's own `src/`.
 */

/** Source extensions a Worker's routes can live in. `.tsx` is included — a route file may render. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

/** Directories never scanned: dependencies, build output, and caches. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", ".wrangler", "coverage", ".git"]);

/**
 * A call to either gate. `\b` before the name keeps `myRequireEntitlement(` out, and requiring the open
 * paren keeps a bare import or a re-export out — an unused import is not a composition error, and
 * reporting one would make the check noise rather than signal.
 */
const GATE_CALL = /\brequire(?:Any)?Entitlement\s*\(/;

/**
 * The source with its comments blanked, so a `// TODO: requireEntitlement("pro")` is not read as a gate.
 *
 * **String-aware, and it has to be.** Doing this with two regexes over raw source looks equivalent and is
 * not: a `/*` inside a string literal opens a comment the scanner never sees closed, and everything up to the
 * next `*&#47;` in the file vanishes. A Worker with `app.get("/assets/*", …)` followed by any doc comment lost
 * whatever sat between them — so a real gate went unseen, `pithy doctor` reported no gap, and the Worker
 * shipped denying every gated route. The same trap in reverse is `https://`, whose `//` is not a comment.
 *
 * So this walks the source once, tracking which of code / string / template / line comment / block comment it
 * is in, and replaces comment characters with spaces rather than removing them — offsets stay put, which keeps
 * anything reported against this text meaningful. It mirrors the string-aware walk `capabilities/reconcile.ts`
 * already does for `pithy.config.ts`; a real parser would be the third option and is far more than a
 * two-identifier search needs.
 */
function withoutComments(source: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? source.length : close + 2;
      // Newlines are kept so line structure survives; everything else becomes a space.
      out.push(source.slice(index, end).replace(/[^\n]/g, " "));
      index = end;
      continue;
    }
    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      out.push(" ".repeat(end - index));
      index = end;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      // Consume the whole literal, escapes included, so nothing inside it is read as code or as a comment.
      let scan = index + 1;
      while (scan < source.length && source[scan] !== char) {
        // A newline ends an unterminated quoted string; a template literal may legally span lines.
        if (source[scan] === "\n" && char !== "`") break;
        scan += source[scan] === "\\" ? 2 : 1;
      }
      const end = Math.min(scan + 1, source.length);
      out.push(source.slice(index, end));
      index = end;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join("");
}

/** Every scannable source file under `dir`, recursively, as paths relative to `dir`. */
async function sourceFiles(dir: string, root: string): Promise<string[]> {
  // No such directory — a Worker need not have a `src/`, and a health check never fails on that.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await sourceFiles(join(dir, entry.name), root)));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * The Worker's own source files that gate a route on an entitlement, relative to the Worker directory
 * and sorted. Only `src/` is scanned: `node_modules` holds the seam's own source, so scanning it would
 * report a gap on every project that installed `@pithy-sh/core`.
 */
export async function entitlementGates(workerDir: string): Promise<string[]> {
  const files = await sourceFiles(join(workerDir, "src"), workerDir);
  const gating: string[] = [];
  for (const file of files) {
    const source = await readFile(join(workerDir, file), "utf8");
    if (GATE_CALL.test(withoutComments(source))) gating.push(file);
  }
  return gating.sort((a, b) => a.localeCompare(b));
}

/** The composed capability that fills the entitlement seam, by name, or null when none does. */
export function entitlementProvider(capabilities: readonly Capability[]): string | null {
  return capabilities.find((capability) => capability.providesEntitlements === true)?.name ?? null;
}

/**
 * The gap: the Worker's gating source files when nothing it composes provides entitlements. Empty
 * otherwise — including when there are no gates at all, which is most projects, and when a provider is
 * composed but nothing gates yet, which is a project mid-build rather than a mistake.
 */
export async function findEntitlementGap(workerDir: string, capabilities: readonly Capability[]): Promise<string[]> {
  if (entitlementProvider(capabilities) !== null) return [];
  return entitlementGates(workerDir);
}
