// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { z } from "zod";
import { writeJsonc } from "./jsonc";

/**
 * **Which linter a new project's six lint safeguards run under.**
 *
 * The starter carries both sets: a GritQL rule per safeguard in `plugins/*.grit`, loaded by `biome.jsonc`, and one
 * Oxlint JS plugin, `plugins/pithy.oxlint.js`, loaded by `.oxlintrc.json`. `pithy init --lint` picks one, and the
 * other set is never copied. Biome stays in an Oxlint project as its formatter, and keeps linting with its
 * recommended rules; only the safeguards move.
 */
export const Linter = z
  .enum(["biome", "oxlint"])
  .describe("The linter that runs the kit's six lint safeguards: `biome` (GritQL rules) or `oxlint` (a JS plugin).");
export type Linter = z.infer<typeof Linter>;

/** The default: what `init` scaffolded before it asked. */
export const DEFAULT_LINTER: Linter = "biome";

/** The Oxlint an Oxlint project installs. The kit's own devDependency, which its parity test runs. */
export const OXLINT_VERSION = "1.88.0";

/** The starter's Oxlint plugin, project-relative. */
export const OXLINT_PLUGIN = "plugins/pithy.oxlint.js";

/** The starter's Oxlint config, as it ships. It lands as `.oxlintrc.json`. */
export const OXLINT_TEMPLATE = "oxlintrc.template.json";

/** The six safeguards, by the name both linters give them. */
export const LINT_RULES = [
  "no-console",
  "no-process-io",
  "no-raw-request-input",
  "no-bare-zvalidator",
  "no-z-config",
  "no-raw-use-effect",
] as const;

/** The `lint` script an Oxlint project runs: Biome checks formatting and its own rules, Oxlint the safeguards. */
export const OXLINT_LINT_SCRIPT = "biome check . && oxlint";

/** Parse `--lint`, refusing anything that is not a linter with the two it could be. */
export function parseLinter(raw: string): Linter {
  const parsed = Linter.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ValidationError({ message: `"${raw}" is not a linter.`, action: "Pass --lint biome or oxlint." });
}

/**
 * Whether a starter file, template-relative with `/` separators, belongs in a project linted by `linter`. Every
 * file that is not one linter's own belongs in both.
 */
export function shipsWith(path: string, linter: Linter): boolean {
  const grit = path.startsWith("plugins/") && path.endsWith(".grit");
  const oxlint = path === OXLINT_PLUGIN || path === OXLINT_TEMPLATE;
  return linter === "biome" ? !oxlint : !grit;
}

/**
 * Finish a scaffolded project for `linter`. A Biome project is the starter as it ships. An Oxlint project's
 * `biome.jsonc` loses its `plugins`, whose `.grit` files were never copied, and its `package.json` gains Oxlint and a
 * `lint` script that runs it after Biome.
 */
export async function applyLinter(targetDir: string, linter: Linter): Promise<void> {
  if (linter === "biome") return;
  const biomePath = join(targetDir, "biome.jsonc");
  const biome = parse(await readFile(biomePath, "utf8")) as unknown as Record<string | symbol, unknown>;
  delete biome.plugins;
  for (const key of Object.getOwnPropertySymbols(biome)) {
    if (key.description?.endsWith(":plugins")) delete biome[key];
  }
  await writeJsonc(biomePath, biome);

  const manifestPath = join(targetDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  manifest.scripts.lint = OXLINT_LINT_SCRIPT;
  manifest.devDependencies = Object.fromEntries(
    Object.entries({ ...manifest.devDependencies, oxlint: OXLINT_VERSION }).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
