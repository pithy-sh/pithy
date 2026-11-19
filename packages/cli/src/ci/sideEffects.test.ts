// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * **Every capability package says which of its modules have side effects, and the answer is true.**
 *
 * A Worker evaluates every module its bundle reaches statically, and a capability's package entry re-exports most
 * of the package. `"sideEffects": false` lets a bundler leave out a re-exported module nothing uses, which is what
 * keeps a Worker's startup to the modules it reaches. It also lets the bundler drop a bare `import "./x"`, which
 * exists only for what `x` does when it loads, so every such import is named in the package's `sideEffects` list,
 * in both its source and its built form: tsdown reads the list when it builds `dist`, and a Worker's bundler reads
 * it again.
 */

const PACKAGES = resolve(import.meta.dirname, "..", "..", "..");

/** A package an adopter's Worker imports: one that declares a capability, and core, which composes them. */
function capabilityPackages(): string[] {
  return readdirSync(PACKAGES).filter(
    (name) => name === "core" || existsSync(join(PACKAGES, name, "src", "capability.ts")),
  );
}

function sideEffectsOf(name: string): unknown {
  return (JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8")) as { sideEffects?: unknown })
    .sideEffects;
}

/** Every bare `import "./…"` in a package's shipped source, as the source path it resolves to. */
function bareImports(name: string): string[] {
  const root = join(PACKAGES, name);
  const found: string[] = [];
  for (const path of sourcePaths(join(root, "src")).filter(isShippedSource)) {
    const text = readSource(path) ?? "";
    for (const match of text.matchAll(/^import\s+["'](\.[^"']+)["'];?$/gm)) {
      found.push(`./${relative(root, resolve(dirname(path), `${match[1]}.ts`))}`);
    }
  }
  return [...new Set(found)].sort();
}

describe("sideEffects", () => {
  test.each(capabilityPackages())("%s declares its side effects", (name) => {
    const declared = sideEffectsOf(name);
    const bare = bareImports(name);
    if (bare.length === 0) {
      expect(declared).toBe(false);
      return;
    }
    const built = bare.map((path) => path.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js"));
    expect(declared).toEqual([...bare, ...built]);
  });
});
