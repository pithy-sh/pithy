// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyLinter, OXLINT_LINT_SCRIPT, OXLINT_VERSION, parseLinter, shipsWith } from "./lint";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("parseLinter", () => {
  test("takes biome and oxlint, and refuses anything else naming both", () => {
    expect(parseLinter("biome")).toBe("biome");
    expect(parseLinter("oxlint")).toBe("oxlint");
    expect(() => parseLinter("eslint")).toThrow(PithyError);
    try {
      parseLinter("eslint");
    } catch (error) {
      expect((error as PithyError).payload).toMatchObject({ code: "validation/invalid_input" });
      expect((error as PithyError).payload.action).toBe("Pass --lint biome or oxlint.");
    }
  });
});

describe("shipsWith", () => {
  test("gives a Biome project the Grit rules and an Oxlint project the plugin and its config", () => {
    expect(shipsWith("plugins/no-console.grit", "biome")).toBe(true);
    expect(shipsWith("plugins/no-console.grit", "oxlint")).toBe(false);
    expect(shipsWith("plugins/pithy.oxlint.js", "biome")).toBe(false);
    expect(shipsWith("plugins/pithy.oxlint.js", "oxlint")).toBe(true);
    expect(shipsWith("oxlintrc.template.json", "biome")).toBe(false);
    expect(shipsWith("oxlintrc.template.json", "oxlint")).toBe(true);
  });

  test("gives both every other file, the Biome config included", () => {
    for (const path of ["biome.template.jsonc", "package.json", "apps/api/src/index.ts", "plugins/README.md"]) {
      expect([shipsWith(path, "biome"), shipsWith(path, "oxlint")]).toEqual([true, true]);
    }
  });
});

test("the Oxlint an Oxlint project installs is the one the kit's parity test runs", async () => {
  const root = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  expect(root.devDependencies.oxlint).toBe(OXLINT_VERSION);
});

describe("applyLinter", () => {
  let dir: string;
  const biome = `{
  // Biome for both lint and format.
  "files": { "ignoreUnknown": true },
  // The gates.
  "plugins": [{ "path": "plugins/no-console.grit", "includes": ["**"] }],
  "linter": { "enabled": true }
}
`;
  const manifest = { name: "x", scripts: { lint: "biome check .", test: "vitest run" }, devDependencies: { zod: "1" } };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-lint-"));
    await writeFile(join(dir, "biome.jsonc"), biome);
    await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("leaves a Biome project exactly as it shipped", async () => {
    await applyLinter(dir, "biome");
    expect(await readFile(join(dir, "biome.jsonc"), "utf8")).toBe(biome);
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual(manifest);
  });

  test("drops the Grit plugins and their comment from an Oxlint project's biome.jsonc, keeping the rest", async () => {
    await applyLinter(dir, "oxlint");
    const text = await readFile(join(dir, "biome.jsonc"), "utf8");
    expect(text).not.toContain("plugins");
    expect(text).not.toContain("// The gates.");
    expect(text).toContain("// Biome for both lint and format.");
    expect(parse(text)).toEqual({ files: { ignoreUnknown: true }, linter: { enabled: true } });
  });

  test("adds Oxlint, pinned, and a lint script that runs it after Biome", async () => {
    await applyLinter(dir, "oxlint");
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({
      ...manifest,
      scripts: { ...manifest.scripts, lint: OXLINT_LINT_SCRIPT },
      devDependencies: { oxlint: OXLINT_VERSION, zod: "1" },
    });
  });
});
