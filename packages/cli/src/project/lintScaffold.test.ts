// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LINT_RULES, OXLINT_LINT_SCRIPT, OXLINT_TEMPLATE, OXLINT_VERSION } from "./lint";
import { pathExists, scaffoldProject } from "./scaffold";

/**
 * What `pithy init` writes for each `--lint`, pinned file by file, and the one property the two configs owe each
 * other: every safeguard covers the same files under either linter.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const STARTER = join(REPO, "templates", "starter");
const OXLINT = join(REPO, "node_modules", "oxlint", "bin", "oxlint");
const BIOME = join(REPO, "node_modules", "@biomejs", "biome", "bin", "biome");

interface BiomePlugin {
  path: string;
  includes: string[];
}
interface OxlintOverride {
  files: string[];
  excludeFiles?: string[];
  rules: Record<string, string>;
}
interface OxlintConfig {
  jsPlugins: string[];
  overrides: OxlintOverride[];
}

const readJsonc = async <T>(path: string) => parse(await readFile(path, "utf8")) as unknown as T;

/** Each rule's `includes`, as the Biome config scopes it. */
function biomeScopes(plugins: readonly BiomePlugin[]): Record<string, string[]> {
  return Object.fromEntries(
    plugins.map((plugin) => [plugin.path.replace(/^plugins\//, "").replace(/\.grit$/, ""), [...plugin.includes]]),
  );
}

/** Each rule's scope as the Oxlint config states it, written the way Biome writes it: `files`, then `!` excludes. */
function oxlintScopes(overrides: readonly OxlintOverride[]): Record<string, string[]> {
  const scopes: Record<string, string[]> = {};
  for (const override of overrides) {
    const rules = Object.keys(override.rules);
    expect(rules, "one safeguard per override").toHaveLength(1);
    const rule = (rules[0] ?? "").replace(/^pithy\//, "");
    scopes[rule] = [...override.files, ...(override.excludeFiles ?? []).map((glob) => `!${glob}`)];
  }
  return scopes;
}

describe("the starter's two lint configs", () => {
  test("scope each safeguard to the same files, includes and excludes alike", async () => {
    const biome = await readJsonc<{ plugins: BiomePlugin[] }>(join(STARTER, "biome.template.jsonc"));
    const oxlint = await readJsonc<OxlintConfig>(join(STARTER, OXLINT_TEMPLATE));
    const scopes = biomeScopes(biome.plugins);
    expect(Object.keys(scopes).sort()).toEqual([...LINT_RULES].sort());
    expect(oxlintScopes(oxlint.overrides)).toEqual(scopes);
  });

  test("target the adopter's layout, never the kit's", async () => {
    const text = `${await readFile(join(STARTER, "biome.template.jsonc"), "utf8")}${await readFile(join(STARTER, OXLINT_TEMPLATE), "utf8")}`;
    expect(text).not.toMatch(/packages\/\*/);
    const biome = await readJsonc<{ plugins: BiomePlugin[] }>(join(STARTER, "biome.template.jsonc"));
    for (const plugin of biome.plugins) expect(plugin.includes[0], plugin.path).toMatch(/^\*\*\/apps\/\*\/src\/\*\*/);
  });
});

describe("pithy init --lint biome, the default", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-lint-biome-"));
    await scaffoldProject({ targetDir: dir, appName: "acme" });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes all six .grit files, byte for byte, and nothing of Oxlint's", async () => {
    expect((await readdir(join(dir, "plugins"))).sort()).toEqual(LINT_RULES.map((rule) => `${rule}.grit`).sort());
    for (const rule of LINT_RULES) {
      expect(await readFile(join(dir, "plugins", `${rule}.grit`), "utf8")).toBe(
        await readFile(join(STARTER, "plugins", `${rule}.grit`), "utf8"),
      );
    }
    expect(await pathExists(join(dir, ".oxlintrc.json"))).toBe(false);
    expect(await pathExists(join(dir, OXLINT_TEMPLATE))).toBe(false);
  });

  test("writes biome.jsonc as the starter ships it, with an entry for each", async () => {
    expect(await readFile(join(dir, "biome.jsonc"), "utf8")).toBe(
      await readFile(join(STARTER, "biome.template.jsonc"), "utf8"),
    );
    const biome = await readJsonc<{ plugins: BiomePlugin[] }>(join(dir, "biome.jsonc"));
    expect(biome.plugins.map((plugin) => plugin.path).sort()).toEqual(
      LINT_RULES.map((rule) => `plugins/${rule}.grit`).sort(),
    );
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(manifest.scripts.lint).toBe("biome check .");
    expect(manifest.devDependencies.oxlint).toBeUndefined();
  });
});

describe("pithy init --lint oxlint", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-lint-oxlint-"));
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "board", lint: "oxlint" });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the plugin and .oxlintrc.json as the starter ships them, and no .grit file", async () => {
    expect(await readdir(join(dir, "plugins"))).toEqual(["pithy.oxlint.js"]);
    expect(await readFile(join(dir, "plugins", "pithy.oxlint.js"), "utf8")).toBe(
      await readFile(join(STARTER, "plugins", "pithy.oxlint.js"), "utf8"),
    );
    expect(await readFile(join(dir, ".oxlintrc.json"), "utf8")).toBe(
      await readFile(join(STARTER, OXLINT_TEMPLATE), "utf8"),
    );
    expect(await pathExists(join(dir, OXLINT_TEMPLATE))).toBe(false);
  });

  test("loads all six rules from the plugin", async () => {
    const config = await readJsonc<OxlintConfig>(join(dir, ".oxlintrc.json"));
    expect(config.jsPlugins).toEqual(["./plugins/pithy.oxlint.js"]);
    const rules = config.overrides.flatMap((override) => Object.entries(override.rules));
    expect(rules.sort()).toEqual(LINT_RULES.map((rule) => [`pithy/${rule}`, "error"]).sort());
  });

  test("keeps Biome as the formatter, without the plugins it no longer has", async () => {
    const biome = await readJsonc<Record<string, unknown>>(join(dir, "biome.jsonc"));
    expect(biome.plugins).toBeUndefined();
    expect(biome.formatter).toMatchObject({ enabled: true });
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(manifest.scripts.lint).toBe(OXLINT_LINT_SCRIPT);
    expect(manifest.devDependencies.oxlint).toBe(OXLINT_VERSION);
  });

  test("still passes biome check, the plugin and .oxlintrc.json included", () => {
    const run = spawnSync(BIOME, ["check", "."], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect({ status: run.status, output: run.stdout + run.stderr }).toMatchObject({ status: 0 });
  }, 60_000);

  test("lints clean with Oxlint, and the plugin fires in the Worker's source", async () => {
    const lint = () => spawnSync(OXLINT, [], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    const clean = lint();
    expect({ status: clean.status, output: clean.stdout + clean.stderr }).toMatchObject({ status: 0 });
    const probe = join(dir, "apps", "board", "src", "probe.ts");
    await writeFile(probe, 'export const probe = (): void => console.log("hi");\n');
    try {
      const dirty = lint();
      expect(dirty.status).not.toBe(0);
      expect(dirty.stdout).toContain("pithy(no-console)");
      expect(dirty.stdout).toContain("createWorkerLogger()");
    } finally {
      await rm(probe, { force: true });
    }
  }, 60_000);
});
