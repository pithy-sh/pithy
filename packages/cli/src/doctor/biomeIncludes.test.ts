// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkBiomeIncludes, unanchoredExclusion } from "./biomeIncludes";

const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "templates", "starter");

describe("unanchoredExclusion", () => {
  test.each([
    ["!**/.worktrees", ".worktrees", ["!.worktrees"]],
    ["!**/.worktrees/**", ".worktrees", ["!.worktrees/**"]],
    ["!**/.worktrees/", ".worktrees", ["!.worktrees/"]],
    ["!*/.worktrees", ".worktrees", ["!.worktrees"]],
    ["!**/x/.worktrees", ".worktrees", ["!x/.worktrees"]],
    ["!**/dist", "dist", ["!dist", "!apps/**/dist"]],
    ["!**/dist/**", "dist", ["!dist/**", "!apps/**/dist/**"]],
    ["!**/.wrangler", ".wrangler", ["!.wrangler", "!apps/**/.wrangler"]],
  ])("%s is matched above the project, so it is named with its anchored lines", (pattern, directory, anchored) => {
    expect(unanchoredExclusion(pattern, ["apps"])).toEqual({ directory, anchored });
  });

  test("the anchored lines for build output cover every top-level directory that holds a workspace member", () => {
    expect(unanchoredExclusion("!**/dist", ["apps", "packages", "shared"])).toEqual({
      directory: "dist",
      anchored: ["!dist", "!apps/**/dist", "!packages/**/dist", "!shared/**/dist"],
    });
    expect(unanchoredExclusion("!**/.worktrees", ["apps", "packages"])).toEqual({
      directory: ".worktrees",
      anchored: ["!.worktrees"],
    });
  });

  test.each([
    "!.worktrees",
    "!.worktrees/**",
    "!./.worktrees",
    "!dist",
    "!.wrangler",
    "!apps/**/dist",
    "!apps/**/.wrangler",
    "**",
    "**/.worktrees",
    "!apps/**/.worktrees",
    "!**/openapi.json",
    "!**/*.generated.*",
  ])("%s is not", (pattern) => {
    expect(unanchoredExclusion(pattern, ["apps"])).toBeNull();
  });
});

describe("checkBiomeIncludes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-biome-includes-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("names every line a project scaffolded with the unanchored exclusions still has, and the lines to write instead", async () => {
    await writeFile(
      join(dir, "biome.jsonc"),
      '{\n  // comment\n  "files": { "includes": ["**", "!**/dist", "!**/.wrangler", "!**/.worktrees", "!**/openapi.json"] }\n}\n',
    );
    expect(await checkBiomeIncludes(dir)).toEqual({
      state: "unanchored",
      findings: [
        'biome.jsonc excludes "!**/dist", which Biome also matches above the project, so in a checkout under a directory named dist it excludes every file. Write "!dist" and "!apps/**/dist" instead.',
        'biome.jsonc excludes "!**/.wrangler", which Biome also matches above the project, so in a checkout under a directory named .wrangler it excludes every file. Write "!.wrangler" and "!apps/**/.wrangler" instead.',
        'biome.jsonc excludes "!**/.worktrees", which Biome also matches above the project, so in a pithy feature create worktree it excludes every file. Write "!.worktrees" instead.',
      ],
    });
  });

  test("a project with workspace members outside apps/ is told to exclude their build output too", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    await mkdir(join(dir, "packages", "shared"), { recursive: true });
    await writeFile(join(dir, "packages", "shared", "package.json"), "{}");
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "biome.jsonc"), '{ "files": { "includes": ["**", "!**/dist", "!**/.wrangler"] } }');
    expect(await checkBiomeIncludes(dir)).toEqual({
      state: "unanchored",
      findings: [
        'biome.jsonc excludes "!**/dist", which Biome also matches above the project, so in a checkout under a directory named dist it excludes every file. Write "!dist", "!apps/**/dist" and "!packages/**/dist" instead.',
        'biome.jsonc excludes "!**/.wrangler", which Biome also matches above the project, so in a checkout under a directory named .wrangler it excludes every file. Write "!.wrangler", "!apps/**/.wrangler" and "!packages/**/.wrangler" instead.',
      ],
    });
  });

  test("reads biome.json when that is the config", async () => {
    await writeFile(join(dir, "biome.json"), JSON.stringify({ files: { includes: ["**", "!**/.worktrees/**"] } }));
    const check = await checkBiomeIncludes(dir);
    expect(check.state).toBe("unanchored");
    expect(check.findings[0]).toMatch(/^biome\.json excludes "!\*\*\/\.worktrees\/\*\*"/);
  });

  test("the starter's own biome.jsonc is ok", async () => {
    await writeFile(join(dir, "biome.jsonc"), await readFile(join(STARTER, "biome.template.jsonc")));
    expect(await checkBiomeIncludes(dir)).toEqual({ state: "ok", findings: [] });
  });

  test("a project with no Biome config, or no files.includes, is ok", async () => {
    expect(await checkBiomeIncludes(dir)).toEqual({ state: "ok", findings: [] });
    await writeFile(join(dir, "biome.jsonc"), "{}");
    expect(await checkBiomeIncludes(dir)).toEqual({ state: "ok", findings: [] });
  });

  test("a config that does not parse could not be checked", async () => {
    await writeFile(join(dir, "biome.jsonc"), "{ nope");
    expect(await checkBiomeIncludes(dir)).toEqual({
      state: "could-not-check",
      findings: ["biome.jsonc does not parse."],
    });
  });
});
