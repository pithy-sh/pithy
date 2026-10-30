// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "comment-json";
import { expect, test } from "vitest";
import { LINT_RULES } from "../project/lint";

/**
 * **The kit lints itself with the rule files the starter ships, and there is no second copy.** A rule the kit kept
 * for itself would drift from the one an adopter gets the first time either was edited, and nothing would say so.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const RULES = "templates/starter/plugins";

test("every plugin in the kit's biome.jsonc is a starter rule, and every starter rule is loaded", async () => {
  const biome = parse(await readFile(join(REPO, "biome.jsonc"), "utf8")) as unknown as { plugins: { path: string }[] };
  const loaded = biome.plugins.map((plugin) => plugin.path).sort();
  expect(loaded).toEqual(LINT_RULES.map((rule) => `${RULES}/${rule}.grit`).sort());
  const shipped = (await readdir(join(REPO, RULES))).filter((name) => name.endsWith(".grit"));
  expect(shipped.map((name) => `${RULES}/${name}`).sort()).toEqual(loaded);
});

test("no .grit file is tracked anywhere but the starter's plugins", () => {
  const tracked = execFileSync("git", ["ls-files", "*.grit"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  expect(tracked.filter((path) => !path.startsWith(`${RULES}/`))).toEqual([]);
});
