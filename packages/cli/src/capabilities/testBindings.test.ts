// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { testBindingKind } from "@pithy-sh/core/src/capability/testBinding";
import { describe, expect, test } from "vitest";

/**
 * Every binding a composed capability can check on the first request is declared as a test binding, so `pithy add`
 * can write the Workers test config a first `fetch` test needs. That includes a binding the manifest marks optional,
 * because a composed instance requires it under the config that needs it, as `controlplane({ replayBackend: "kv" })`
 * requires `CONTROL_PLANE`. Repo-wide over the shipped manifests: the property only holds as a set.
 */

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages");

/** Every shipped manifest file, `pithy.manifest.json` and the extra ones beside it, by package directory. */
function shippedManifests(): { pkg: string; file: string; manifest: CapabilityManifest }[] {
  const found: { pkg: string; file: string; manifest: CapabilityManifest }[] = [];
  for (const pkg of readdirSync(PACKAGES).sort()) {
    const dir = join(PACKAGES, pkg);
    if (!existsSync(join(dir, "package.json"))) continue;
    for (const file of readdirSync(dir).filter((name) => /^pithy(\.[a-z]+)?\.manifest\.json$/.test(name))) {
      const manifest = CapabilityManifest.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      found.push({ pkg, file, manifest });
    }
  }
  return found;
}

const MANIFESTS = shippedManifests();

describe("every capability declares the test bindings its composition checks", () => {
  test("the sweep reads the manifests", () => {
    // A walk that found nothing would pass every assertion below.
    expect(MANIFESTS.map(({ manifest }) => manifest.name)).toEqual(
      expect.arrayContaining(["secrets", "auth", "mcp", "email", "matchmaking", "controlplane"]),
    );
  });

  test.each(MANIFESTS.map((entry) => [`${entry.pkg}/${entry.file}`, entry] as const))(
    "%s declares one test binding per required binding, optional ones included, of the kind its type takes",
    (_label, { manifest }) => {
      // An optional binding is one a composed instance may still require, under the config that needs it.
      const expected = manifest.requiredBindings
        .map((binding) => `${testBindingKind(binding.type)}:${binding.name}`)
        .sort();
      const declared = manifest.testBindings.map((binding) => `${binding.kind}:${binding.name}`).sort();
      expect(declared).toEqual(expected);
    },
  );

  test.each(
    MANIFESTS.flatMap(({ pkg, manifest }) =>
      manifest.testBindings.flatMap((binding) =>
        binding.kind === "value" ? [[`${manifest.name}:${binding.name}`, pkg, manifest.package, binding] as const] : [],
      ),
    ),
  )("%s computes its value in a dependency-free module of its own package", (_label, pkg, packageName, binding) => {
    expect(binding.module.startsWith(`${packageName}/src/`)).toBe(true);
    const source = readFileSync(join(PACKAGES, pkg, `${binding.module.slice(packageName.length + 1)}.ts`), "utf8");
    expect(source).toMatch(new RegExp(`^export function ${binding.export}\\(\\)`, "m"));
    // A `vitest.workers.config.ts` is loaded by Node's resolver, which cannot follow the extensionless
    // specifiers the kit's sources use, so the module may import types and nothing else.
    const valueImports = source.split("\n").filter((line) => /^import\s/.test(line) && !/^import type\s/.test(line));
    expect(valueImports).toEqual([]);
  });
});
