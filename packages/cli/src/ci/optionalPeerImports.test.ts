// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, test } from "vitest";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * **A package's shipped code never imports a kit package it declares only as an optional peer.** (#645)
 *
 * An optional peer is a capability the adopter may or may not compose: `payments` credits a balance through
 * `ledger` when a product says so, `support` links a sender to an account through `auth` when there is one.
 * Whether it is there is decided by the composition, and the code that uses it cannot see the composition at
 * bundle time. A bundler can see a specifier, and it resolves every one it finds whether or not the branch
 * holding it ever runs:
 *
 *     ✘ [ERROR] Could not resolve "@pithy-sh/ledger/src/ledger"
 *
 * That was `import("@pithy-sh/ledger/src/ledger")` inside a `try`, written to keep the ledger optional. It was
 * optional at runtime and required at bundle time, so every project composing payments without ledger could
 * not deploy its payments host. Twenty-four specifiers in nine modules across six packages had the same shape.
 *
 * So the peer arrives the other way round. The peer capability carries a surface (`ledgerPeer`, `authPeer`,
 * …), the dependent finds it among the composed capabilities in its `compose` hook, and a host Worker — which
 * composes nothing — is handed it by the entry the CLI generates when the project composes the peer. Nothing
 * the dependent ships names the package, so there is nothing for a bundler to resolve.
 *
 * **What counts is a value import**: `import { x } from`, a side-effect `import`, `export … from`, and a
 * literal `import()`. A type-only import is erased before any bundler sees it, and `typeof import("…")` in a
 * type position is a type. Relative imports are followed by reading every file, which is why this walks the
 * whole of `src/` rather than chasing entries: a module reachable only through a relative dynamic import was
 * one of the nine.
 *
 * **Only kit peers.** A non-kit optional peer — `react`, for `payments/src/client/hooks.ts` — is a module the
 * adopter imports on purpose, having installed React to do it. No composition decides it, so nothing here is
 * about it.
 *
 * Derived from each manifest's `peerDependenciesMeta`, never listed: a package that marks a new kit peer
 * optional tomorrow is held to this tomorrow.
 */

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

const SCOPE = "@pithy-sh/";

/** The parts of a manifest this reads. */
interface Manifest {
  readonly name?: string;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** An oxc ESTree node, as far as this walk needs one. */
interface Node {
  readonly type?: string;
  readonly [key: string]: unknown;
}

/** One import that names an optional peer. */
interface OptionalPeerImport {
  /** Repo-relative path of the importing module. */
  readonly file: string;
  /** The peer package it names. */
  readonly peer: string;
  /** The specifier as written. */
  readonly specifier: string;
}

/** The kit package a specifier names, or undefined for a relative or non-kit one. */
function kitPackage(specifier: string): string | undefined {
  if (!specifier.startsWith(SCOPE)) return undefined;
  return specifier.split("/").slice(0, 2).join("/");
}

/** A string literal's value, from a `Literal` or an expression-free template. */
function literal(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = node as Node;
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  if (value.type === "TemplateLiteral" && Array.isArray(value.expressions) && value.expressions.length === 0) {
    const quasis = value.quasis as readonly { value: { cooked?: string } }[];
    return quasis.map((quasi) => quasi.value.cooked ?? "").join("");
  }
  return undefined;
}

/** Whether an `import` declaration binds any value — a side-effect import does, and so does any value specifier. */
function importsValue(node: Node): boolean {
  if (node.importKind === "type") return false;
  const specifiers = (node.specifiers ?? []) as readonly Node[];
  if (specifiers.length === 0) return true;
  return specifiers.some((specifier) => specifier.importKind !== "type");
}

/** Every specifier a module imports as a value — static, re-exported, or through a literal `import()`. */
function valueSpecifiers(text: string): string[] {
  const found: string[] = [];
  const program = parseAst(text, { lang: "ts" }, "source.ts") as unknown as Node;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Node;
    switch (node.type) {
      case "ImportDeclaration": {
        const specifier = literal(node.source);
        if (specifier !== undefined && importsValue(node)) found.push(specifier);
        return;
      }
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        const specifier = literal(node.source);
        if (specifier !== undefined && node.exportKind !== "type") found.push(specifier);
        break;
      }
      case "ImportExpression": {
        const specifier = literal(node.source);
        if (specifier !== undefined) found.push(specifier);
        break;
      }
      // `typeof import("…")` — a type, erased with every other one.
      case "TSImportType":
        return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "parent") continue;
      visit(child);
    }
  };
  visit(program);
  return found;
}

/** Every workspace package directory under `packages/`. */
function members(): string[] {
  return readdirSync(join(REPO_ROOT, "packages"))
    .map((name) => join(REPO_ROOT, "packages", name))
    .filter((directory) => readSource(join(directory, "package.json")) !== null)
    .sort();
}

/** A package's kit peers that it marks optional. */
function optionalKitPeers(directory: string): string[] {
  const manifest = JSON.parse(readSource(join(directory, "package.json")) ?? "{}") as Manifest;
  return Object.keys(manifest.peerDependencies ?? {})
    .filter((name) => name.startsWith(SCOPE) && manifest.peerDependenciesMeta?.[name]?.optional === true)
    .sort();
}

/** Every value import of an optional kit peer in one package's shipped source. */
function optionalPeerImports(
  optional: readonly string[],
  files: readonly { path: string; text: string }[],
): OptionalPeerImport[] {
  const found: OptionalPeerImport[] = [];
  for (const file of files) {
    for (const specifier of valueSpecifiers(file.text)) {
      const peer = kitPackage(specifier);
      if (peer !== undefined && optional.includes(peer)) {
        found.push({ file: relative(REPO_ROOT, file.path).split(sep).join("/"), peer, specifier });
      }
    }
  }
  return found;
}

/** The shipped source of one package, read. */
function shippedFiles(directory: string): { path: string; text: string }[] {
  return sourcePaths(join(directory, "src"), { keep: isShippedSource }).flatMap((path) => {
    const text = readSource(path);
    return text === null ? [] : [{ path, text }];
  });
}

describe("the detector, proved against fixtures before it is trusted against the tree", () => {
  const OPTIONAL = ["@pithy-sh/ledger"];
  const scan = (text: string) =>
    optionalPeerImports(OPTIONAL, [{ path: join(REPO_ROOT, "fixture.ts"), text }]).map((found) => found.specifier);

  test("a literal dynamic import is a value import — the #645 shape", () => {
    expect(scan('export const load = () => import("@pithy-sh/ledger/src/ledger");')).toEqual([
      "@pithy-sh/ledger/src/ledger",
    ]);
  });

  test("a static value import, a side-effect import and a re-export all count", () => {
    expect(
      scan(
        [
          'import { openLedger } from "@pithy-sh/ledger/src/ledger";',
          'import "@pithy-sh/ledger/src/capability";',
          'export { ledger } from "@pithy-sh/ledger/src/capability";',
          "export const x = openLedger;",
        ].join("\n"),
      ),
    ).toEqual(["@pithy-sh/ledger/src/ledger", "@pithy-sh/ledger/src/capability", "@pithy-sh/ledger/src/capability"]);
  });

  test("a mixed import counts, because one value specifier is enough to need the package", () => {
    expect(scan('import { type Ledger, openLedger } from "@pithy-sh/ledger/src/ledger";\nopenLedger;')).toEqual([
      "@pithy-sh/ledger/src/ledger",
    ]);
  });

  test("a type-only import, and `typeof import()` in a type, are erased and do not count", () => {
    expect(
      scan(
        [
          'import type { Ledger } from "@pithy-sh/ledger/src/ledger";',
          'import { type LedgerPeer } from "@pithy-sh/ledger/src/peer";',
          'export type { LedgerCapability } from "@pithy-sh/ledger/src/capability";',
          'type Open = typeof import("@pithy-sh/ledger/src/ledger").openLedger;',
          "export type T = Ledger | LedgerPeer | Open;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a required peer, a relative module and a comment are not optional-peer imports", () => {
    expect(
      scan(
        [
          'import { z } from "zod";',
          'import { InternalError } from "@pithy-sh/core/src/error/pithyError";',
          'const lazy = () => import("../publish/leaderboard");',
          '// import("@pithy-sh/ledger/src/ledger") is what this file used to do.',
          "export { z, InternalError, lazy };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("no package imports a kit package it declares only as an optional peer", () => {
  const packages = members().map((directory) => ({ directory, optional: optionalKitPeers(directory) }));

  // The vacuity floor: a manifest walk that stopped finding optional peers satisfies the assertion below
  // without reading a line of source.
  test("there are optional kit peers to hold packages to", () => {
    const declarers = packages.filter((entry) => entry.optional.length > 0).map((entry) => entry.directory);
    expect(declarers.length).toBeGreaterThanOrEqual(6);
    expect(packages.find((entry) => entry.directory.endsWith(`${sep}payments`))?.optional).toContain(
      "@pithy-sh/ledger",
    );
  });

  test("every optional kit peer arrives through the composition, never through a specifier", () => {
    const found = packages.flatMap((entry) =>
      entry.optional.length === 0 ? [] : optionalPeerImports(entry.optional, shippedFiles(entry.directory)),
    );
    expect(found.map((entry) => `${entry.file} imports ${entry.specifier}`)).toEqual([]);
  });
});
