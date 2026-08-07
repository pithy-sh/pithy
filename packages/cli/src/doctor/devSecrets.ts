// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { DEV_SECRETS_FILE } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { loadDevSecrets } from "@pithy-sh/secrets/src/dev/loadDevSecrets";
import { devSecretsPath } from "../devSecrets/file";
import { type DevSecretsTarget, devSecretsTargets } from "../devSecrets/seed";

/**
 * Whether this project's secrets are in the file they belong in — the migration notice for every project
 * that predates `.dev.secrets.jsonc` (#149).
 *
 * **Reported, never fixed.** `pithy add` does not move an adopter's `.dev.vars` line and neither does
 * this: rewriting a file someone hand-maintains, over a convention they have not read about yet, is how
 * a toolchain loses trust. Doctor names each one and says where it goes, every run, until they move it.
 *
 * **A misplaced secret does not fail the exit either.** An existing project has these by definition, and
 * an upgrade that turns a green `pithy doctor` red in CI over a file that still works is a surprise, not
 * a diagnosis. The rule the block is held to: say it clearly, cost nothing.
 *
 * **`d1` only.** `CLOUDFLARE_API_TOKEN` is `cf-secrets-store`-backed and genuinely lives in `.dev.vars`
 * — there is no local Secrets Store to seed it into — so naming it misplaced would send an adopter to
 * break their own project. The registry's `backend` decides, here exactly as it does in the seeder.
 */

/** One declared secret found in `.dev.vars` that belongs in `.dev.secrets.jsonc`. */
export interface MisplacedDevSecret {
  /** The registry secret name, as it appears in both files. */
  name: string;
  /**
   * Whether `.dev.secrets.jsonc` also carries it. Two copies is the worse case, not the better one: the
   * values can differ, dev reads the `.dev.vars` one today, and nothing says so.
   */
  alsoStated: boolean;
}

/** What doctor learned about this project's dev secrets. */
export interface DevSecretsCheck {
  /** The resolved `.dev.secrets.jsonc` path — the answer to "where does this go", file or no file. */
  path: string;
  /** Declared `d1`-backed secrets sitting in `.dev.vars`. Empty is the healthy state. */
  misplaced: MisplacedDevSecret[];
  /**
   * Declared secrets with no value in either file and nothing honest to mint — an OAuth client secret, a
   * Stripe key. **Not a fault.** Almost every project sets none of auth's four provider pairs, and the
   * capability that reads one fails with its own `secrets/not_found` naming it. It is here because this
   * is the only place that can list them without running anything, and nowhere else says them once
   * instead of on every `pithy dev`.
   */
  missing: string[];
  /**
   * Names in `.dev.secrets.jsonc` that no capability declares — the residue of a removed capability, or a
   * typo. **Not a fault either**, and never fatal to a seed: a stale line must not brick dev. Reported so
   * a value nobody reads can be deleted rather than maintained.
   */
  undeclared: string[];
  /** The file's permission bits, or `null` when there is no file. Anything wider than `0o600` is a finding. */
  mode: number | null;
  /** Whether the file is there and will not parse — the one state that hides everything else. */
  unreadable: boolean;
}

/** What {@link checkDevSecrets} needs. `targets` is the seam; it defaults to the real project's Workers. */
export interface CheckDevSecretsOptions {
  /** The project root. */
  projectDir: string;
  /** The Workers whose registries declare the secrets. Defaults to every one composing `secrets`. */
  targets?: DevSecretsTarget[];
}

/**
 * Read the two files and compare them against the registry. Never throws — a diagnostic has to work in
 * the broken environment it exists to diagnose. `null` means no Worker composes `secrets`, so there is
 * no registry, no declared name, and no question to answer.
 */
export async function checkDevSecrets(options: CheckDevSecretsOptions): Promise<DevSecretsCheck | null> {
  const targets = options.targets ?? (await devSecretsTargets(options.projectDir));
  if (targets.length === 0) return null;

  const path = devSecretsPath(options.projectDir);
  const inDevVars = parseDevVars(await readFile(join(options.projectDir, ".dev.vars"), "utf8").catch(() => ""));

  const source = await readFile(path, "utf8").catch(() => null);
  let stated: Record<string, unknown> = {};
  let unreadable = false;
  if (source !== null) {
    try {
      stated = loadDevSecrets(source, { path });
    } catch {
      unreadable = true;
    }
  }

  const misplaced: MisplacedDevSecret[] = [];
  const missing = new Set<string>();
  const seen = new Set<string>();
  for (const target of targets) {
    for (const [name, entry] of Object.entries(target.registry)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // A keyspace has no single value: its members are written by the app at runtime, one per key.
      // Nothing about it can be missing from a file that was never meant to carry it.
      if (entry.keyed) continue;
      if (inDevVars[name]) {
        if (entry.backend === "d1") misplaced.push({ name, alsoStated: name in stated });
        continue;
      }
      // Mintable means the next seed supplies it. Only a value that has to come from somewhere real is
      // something the adopter has to do — and the file, not the store, is dev's source of truth for it.
      if (!(name in stated) && !entry.devValue) missing.add(name);
    }
  }
  misplaced.sort((a, b) => a.name.localeCompare(b.name));

  const mode = source === null ? null : ((await stat(path).catch(() => null))?.mode ?? 0) & 0o777;
  // A file that will not parse tells us nothing about what is in it, so every declared secret would read
  // as missing and nothing in it could be judged declared. Saying "your file is broken" once beats saying
  // it again eleven times in other words.
  const undeclared = unreadable
    ? []
    : Object.keys(stated)
        .filter((name) => !seen.has(name))
        .sort();
  return { path, misplaced, missing: unreadable ? [] : [...missing].sort(), undeclared, mode, unreadable };
}

/** Whether the file is readable by anyone but its owner. `null` (no file) is not wide. */
function wideOpen(mode: number | null): boolean {
  return mode !== null && (mode & 0o077) !== 0;
}

/**
 * Whether there is anything here to *fix* — as opposed to anything to say.
 *
 * The distinction is the whole reason this is separate from {@link describeDevSecrets}. A missing OAuth
 * client secret is worth listing and is not a fault: almost every project has four of them and will
 * never set one. Counting it as a fault would drag the entire doctor report verbose for every project
 * in the world, which is how a report stops being read.
 */
export function devSecretsHealthy(check: DevSecretsCheck): boolean {
  return check.misplaced.length === 0 && !check.unreadable && !wideOpen(check.mode);
}

/**
 * The lines the report prints for this check, or none at all when there is nothing to say. Silence is
 * the healthy answer: a project with its secrets in the right file does not need a line telling it so.
 */
export function describeDevSecrets(check: DevSecretsCheck): string[] {
  const lines: string[] = [];
  if (check.unreadable) {
    lines.push(`${DEV_SECRETS_FILE} will not parse. Run pithy seed to see which secret and why.`);
  }
  for (const { name, alsoStated } of check.misplaced) {
    lines.push(
      alsoStated
        ? `${name} is in both .dev.vars and ${DEV_SECRETS_FILE}. Dev reads the .dev.vars one. Delete that line.`
        : `${name} is in .dev.vars. It belongs in ${DEV_SECRETS_FILE} as { "currentVersion": "1", "versions": { "1": <value> } }.`,
    );
  }
  if (check.undeclared.length > 0) {
    lines.push(
      `${DEV_SECRETS_FILE} carries ${check.undeclared.join(", ")}, which no capability declares. Nothing reads them.`,
    );
  }
  if (check.missing.length > 0) {
    lines.push(
      `No dev value for ${check.missing.join(", ")}. Each is issued by somebody else, so nothing mints one. Fine to leave until you need it.`,
    );
  }
  if (wideOpen(check.mode)) {
    lines.push(
      `${DEV_SECRETS_FILE} is mode ${(check.mode ?? 0).toString(8)}. It holds OAuth client secrets. Run chmod 600 on it.`,
    );
  }
  return lines;
}
