// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { SEED_ARTIFACT_DIR } from "@pithy-sh/core/src/seed/devLogin";
import type { SeedArtifact } from "@pithy-sh/core/src/seed/seed";

/**
 * The CLI half of the prepared-set seam: everything a `SeedSet.prepare` hook needs from the machine, kept
 * here because a capability module is bundled into the Worker and cannot reach the filesystem at all.
 * The hook gets values and callbacks; the disk stays on this side.
 */

/** The environment variables the preference path is resolved from — injected so tests need no real `$HOME`. */
export type ProcessEnv = Record<string, string | undefined>;

/**
 * Where a developer states their machine-local preferences for one project: `$XDG_CONFIG_HOME/<project>/dev.json`,
 * falling back to `~/.config` when the variable is unset or empty (an empty value is not a directory, and
 * treating it as one would resolve the path against the filesystem root).
 *
 * Outside the repo on purpose. A machine opts itself in with no commit and no per-run flag, and two
 * developers sharing one checkout can be different people.
 */
export function devPreferencesPath(project: string, env: ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return join(configHome, project, "dev.json");
}

/**
 * Read {@link devPreferencesPath}, parsed but unvalidated — the set that consumes it owns its shape.
 *
 * An absent file is the default (and means "seed nothing extra"), so it is `undefined`, not an error. So is
 * an unparseable one: this file is hand-edited, and a half-typed preference should not fail a whole seed
 * run. A file that parses but says the wrong thing is a different matter, and the set rejects it loudly.
 */
export async function readDevPreferences(project: string, env: ProcessEnv = process.env): Promise<unknown> {
  try {
    return JSON.parse(await readFile(devPreferencesPath(project, env), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Read a named secret out of the project's `.dev.vars`.
 *
 * That is where local dev's secrets genuinely live: `secretsStore` resolves every secret from an injected
 * `.dev.vars` string when `ENVIRONMENT` is not a managed environment, whatever the registry backend says.
 * So this reads the same value the running Worker will, from the same place — no store, no master key.
 *
 * A deployed environment's secrets are not on the operator's disk, so this answers `undefined` there. A set
 * that needs a secret is therefore a `dev`-only set, which is exactly the guard rail the one caller wants.
 */
export function devSecretReader(projectDir: string): (name: string) => Promise<string | undefined> {
  return async (name: string) => {
    try {
      return parseDevVars(await readFile(join(projectDir, ".dev.vars"), "utf8"))[name];
    } catch {
      return undefined;
    }
  };
}

/**
 * Write one prepared artifact under the project's `logs/`, returning the path written.
 *
 * The directory is not the fixture's to choose: `logs/` is gitignored by the starter template, and the one
 * artifact that exists holds a live session cookie. A `file` carrying any directory part is refused rather
 * than normalized — a fixture that tried it is a bug, and silently relocating it would hide the bug.
 */
export async function writeSeedArtifact(projectDir: string, artifact: SeedArtifact): Promise<string> {
  if (artifact.file !== basename(artifact.file) || artifact.file.startsWith(".")) {
    throw new ValidationError({
      message: "A seed artifact must be a plain file name.",
      action: `Name the file itself; it is always written into ${SEED_ARTIFACT_DIR}/.`,
      detail: `artifact file "${artifact.file}" is not a plain basename`,
    });
  }
  const dir = join(projectDir, SEED_ARTIFACT_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, artifact.file);
  await writeFile(path, artifact.contents, "utf8");
  return path;
}
