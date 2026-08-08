// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { loadDevSecrets } from "@pithy-sh/secrets/src/dev/loadDevSecrets";
import { DEV_SECRETS_FILE_NAME, resolveDevSecretsFile } from "../devSecrets/location";
import { type DevSecretsTarget, devSecretsTargets } from "../devSecrets/targets";
import { type StatePathOptions, stateDir } from "../notifier/state";
import { isCloudflareEnvKey } from "./devVars";

/**
 * Whether this project's secrets are in the file they belong in — the migration notice for every project
 * that predates the dev secrets file (#149).
 *
 * **Every line names the absolute path.** The file is outside the checkout since #156, so
 * "your secrets file will not parse" named a file the reader could not find — see
 * {@link checkDevSecretsLocation}, which prints the path on every run whether or not anything is wrong.
 *
 * **Reported, never fixed.** `pithy add` does not move an adopter's `.dev.vars` line and neither does
 * this: rewriting a file someone hand-maintains, over a convention they have not read about yet, is how
 * a toolchain loses trust. Doctor names each one and says where it goes, every run, until they move it.
 *
 * **A misplaced secret does not fail the exit either.** An existing project has these by definition, and
 * an upgrade that turns a green `pithy doctor` red in CI over a file that still works is a surprise, not
 * a diagnosis. The rule the block is held to: say it clearly, cost nothing.
 *
 * **Every backend, and only the project root's file (#178).** This reads `<root>/.dev.vars` — the
 * hand-written one, which since #154 nothing but the CLI reads, and which the CLI reads for
 * {@link CLOUDFLARE_ENV_KEYS} alone. A registry secret sitting there is inert whatever its backend, and
 * that list is what says so. It used to be inferred from `backend: "d1"` instead, on the grounds that
 * `CLOUDFLARE_API_TOKEN` has no local Secrets Store to live in — true of that one name, not of the
 * backend, so the dashboard's own `cf-secrets-store` secrets sat stranded there unreported.
 *
 * The generated `apps/<w>/.dev.vars` is a different file and is not read here. A `cf-secrets-store`
 * secret belongs in *that* one — it is the only place a Worker can read one from, and putting it there
 * is what `pithy seed` is for.
 *
 * **And every copy it names is now inert (#153).** Through the transition the seeder wrote each `d1`
 * value into `.dev.vars` as well, because that binding was where dev read it — so this block had to tell
 * pithy's own current copy apart from an adopter's, or it would have told every project to do the one
 * thing that broke dev. Dev reads the seeded row now and pithy writes no such copy, so what is left in
 * `.dev.vars` is a line nothing reads, in either of the two ways it can get there.
 */

/** Why a declared `d1` secret is sitting in `.dev.vars`. Two states, two different fixes. */
export type MisplacedDevSecretState =
  /**
   * Both files carry it. The move is done and the old line was never deleted — or it is the copy the
   * #149 transition injected, which pithy no longer writes. Nothing reads it; it can go.
   */
  | "duplicate"
  /**
   * Only `.dev.vars` has it: the pre-#149 project, with nothing moved yet. The migration notice — and
   * since #153 the value is not resolving either, so the move is the fix rather than tidiness.
   */
  | "unmoved";

/** One declared `d1` secret found in `.dev.vars`, and what its being there means. */
export interface MisplacedDevSecret {
  /** The registry secret name, as it appears in both files. */
  name: string;
  /** Which of the two situations this is — delete the line, or move the value into the file. */
  state: MisplacedDevSecretState;
}

/** What doctor learned about this project's dev secrets. */
export interface DevSecretsCheck {
  /** The resolved absolute secrets-file path — the answer to "where does this go", file or no file. */
  path: string;
  /**
   * Declared `d1`-backed secrets sitting in `.dev.vars`. Empty is the healthy state — and also the
   * honest answer when {@link unreadable}, because the state of each one is decided against a file that
   * would not parse.
   */
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
   * Declared **bootstrap** secrets with no value — `SECRETS_ENCRYPTION_KEYS` above all. Kept apart from
   * {@link missing} because the answer is a different one: nothing outside the project issues a master
   * key, `pithy add secrets` mints it, and until it does the local `SECRETS` store cannot be opened at
   * all. Telling somebody it is "issued by somebody else, fine to leave until you need it" is the one
   * sentence that would send them past the thing actually stopping them.
   */
  bootstrapMissing: string[];
  /**
   * Names in the secrets file that no capability declares — the residue of a removed capability, or a
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
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test reads its own. */
  paths?: StatePathOptions;
}

/**
 * Read the two files and compare them against the registry. Never throws — a diagnostic has to work in
 * the broken environment it exists to diagnose. `null` means no Worker composes `secrets`, so there is
 * no registry, no declared name, and no question to answer.
 */
export async function checkDevSecrets(options: CheckDevSecretsOptions): Promise<DevSecretsCheck | null> {
  const targets = options.targets ?? (await devSecretsTargets(options.projectDir));
  if (targets.length === 0) return null;

  const path = await resolveDevSecretsFile(options.projectDir, options.paths ?? {});
  const inDevVars = parseDevVars(await readFile(join(options.projectDir, ".dev.vars"), "utf8").catch(() => ""));

  const source = await readFile(path, "utf8").catch(() => null);
  let stated: DevSecretsFile = {};
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
  const bootstrapMissing = new Set<string>();
  const seen = new Set<string>();
  for (const target of targets) {
    for (const [name, entry] of Object.entries(target.registry)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // A keyspace has no single value: its members are written by the app at runtime, one per key.
      // Nothing about it can be missing from a file that was never meant to carry it.
      if (entry.keyed) continue;
      // `Object.hasOwn`, never `in`, and an own-property read of both maps. `in` walks the prototype
      // chain, so a secret named `constructor` or `toString` read as stated in an empty file — and this
      // is the module that judges adopter-supplied names against a registry, so it is where a name
      // chosen to look like an `Object.prototype` key would be aimed.
      const stranded = Object.hasOwn(inDevVars, name) ? inDevVars[name] : undefined;
      if (stranded !== undefined && stranded !== "") {
        // Whatever the backend. `backend` says where a *seeded* value lands — a D1 row, or a binding —
        // and it was standing in for a different question: is the root `.dev.vars` a file anything
        // reads this name out of. {@link CLOUDFLARE_ENV_KEYS} is the whole answer, and it is the list
        // the readers themselves use. Which of the two states it is depends only on whether the
        // secrets file states it too.
        if (!isCloudflareEnvKey(name))
          misplaced.push({ name, state: Object.hasOwn(stated, name) ? "duplicate" : "unmoved" });
        continue;
      }
      // Mintable means the next seed supplies it. Only a value that has to come from somewhere real is
      // something the adopter has to do — and the file, not the store, is dev's source of truth for it.
      if (Object.hasOwn(stated, name) || entry.devValue) continue;
      if (entry.bootstrap) bootstrapMissing.add(name);
      else missing.add(name);
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
  return {
    path,
    // Nor can it say anything true about `.dev.vars`. Both states are decided against what the secrets
    // file states, and an unparseable file states nothing — so every copy would read as `unmoved` and the
    // adopter would be told to move a value that is already there. Say the file is broken, once.
    misplaced: unreadable ? [] : misplaced,
    missing: unreadable ? [] : [...missing].sort(),
    bootstrapMissing: unreadable ? [] : [...bootstrapMissing].sort(),
    undeclared,
    mode,
    unreadable,
  };
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
  // Every misplaced secret counts now. Through the transition one state did not — pithy wrote that copy
  // itself, every run, and calling the toolchain's own bookkeeping a fault would have dragged every
  // project on the branch verbose forever. It writes none, so there is nothing left to excuse.
  return check.misplaced.length === 0 && !check.unreadable && !wideOpen(check.mode);
}

/**
 * The lines the report prints for this check, or none at all when there is nothing to say. Silence is
 * the healthy answer: a project with its secrets in the right file does not need a line telling it so.
 */
export function describeDevSecrets(check: DevSecretsCheck): string[] {
  const lines: string[] = [];
  if (check.unreadable) {
    lines.push(`${check.path} will not parse. Run pithy seed to see which secret and why.`);
  }
  for (const { name, state } of check.misplaced) {
    lines.push(describeMisplaced(name, state, check.path));
  }
  if (check.undeclared.length > 0) {
    lines.push(
      `${check.path} carries ${check.undeclared.join(", ")}, which no capability declares. Nothing reads them.`,
    );
  }
  if (check.bootstrapMissing.length > 0) {
    lines.push(
      `No dev value for ${check.bootstrapMissing.join(", ")}. Run pithy add secrets — it mints one into ${check.path}. Until then the local SECRETS store cannot be opened.`,
    );
  }
  if (check.missing.length > 0) {
    lines.push(
      `No dev value for ${check.missing.join(", ")}. Each is issued by somebody else, so nothing mints one. Fine to leave until you need it.`,
    );
  }
  if (wideOpen(check.mode)) {
    lines.push(
      `${check.path} is mode ${(check.mode ?? 0).toString(8)}. It holds OAuth client secrets. Run chmod 600 on it.`,
    );
  }
  return lines;
}

/**
 * The one sentence for each state. Both name the file the value belongs in, because it is outside the
 * checkout and nothing in the project points at it.
 *
 * Neither says the value is at risk, and that is the honest reading: `.dev.vars` is not read for a `d1`
 * secret any more, so a line there is inert rather than competing. Saying "dev reads that one" was true
 * before #153 and is the sentence that would send an adopter the wrong way now.
 */
function describeMisplaced(name: string, state: MisplacedDevSecretState, path: string): string {
  switch (state) {
    case "duplicate":
      return `${name} is in .dev.vars as well as ${path}. Nothing reads the .dev.vars one — delete that line.`;
    case "unmoved":
      return `${name} is in .dev.vars, which dev no longer reads. Move it into ${path} as { "currentVersion": "1", "versions": { "1": <value> } }.`;
  }
}

/**
 * Where this project's secrets file is, whether it is there, and which sibling project directories
 * hold one — the block that exists because the file no longer does (#156).
 *
 * **The path prints on every run, healthy or not — terse report included (#166).** Everything else in
 * `pithy doctor` reports a fault; this reports a location, because a file outside the checkout is
 * invisible otherwise. Nothing in the project names it, `ls` will not find it, and "where are my dev
 * secrets" has no other answer. Suppressing it when nothing is wrong hid it from the one developer with
 * no other symptom to search on.
 *
 * **The orphan list is the rename trail.** The directory is keyed on the project's `name`, so renaming
 * a project — or scaffolding a second one that happens to share a name — silently changes which file
 * every command reads. The old one is still there with every value in it, and nothing would ever
 * mention it again. Listed **only when this project has no file of its own**, which is exactly the
 * shape a rename leaves and is silence for every developer whose project is working: a machine with
 * six projects on it should not hear about five of them on every run.
 */
export interface DevSecretsLocationCheck {
  /** The resolved absolute path — `<config>/<project>/secrets.jsonc`. Always set, file or no file. */
  path: string;
  /** Whether anything is at {@link path}. `false` is the ordinary state of a project with no secrets. */
  present: boolean;
  /**
   * Other project names under the config directory that do have a secrets file, sorted. Empty unless
   * this project has none of its own — see above. Names, never paths and never values.
   */
  orphans: string[];
}

/**
 * Resolve the path and look around it. Never throws — a diagnostic has to work in the broken
 * environment it exists to diagnose. `null` means there is no project name to key on, which is the
 * same condition {@link checkDevPreferences} declines to answer under, and the `Project:` block above
 * has already said which of the two it is.
 */
export async function checkDevSecretsLocation(
  projectDir: string,
  options: StatePathOptions = {},
): Promise<DevSecretsLocationCheck | null> {
  let path: string;
  try {
    path = await resolveDevSecretsFile(projectDir, options);
  } catch {
    return null;
  }
  const present = (await stat(path).catch(() => null)) !== null;
  return { path, present, orphans: present ? [] : await siblingsWithSecrets(stateDir(options), path) };
}

/**
 * Project directories under the config root that carry a secrets file, minus this project's own.
 *
 * `readdir` and one `stat` each — no config is loaded, because these are other checkouts' projects and
 * this machine may no longer have any of them. That is the whole point: a directory whose project is
 * gone is exactly the one nothing else can report.
 */
async function siblingsWithSecrets(configDir: string, ours: string): Promise<string[]> {
  const entries = await readdir(configDir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(configDir, entry.name, DEV_SECRETS_FILE_NAME);
    if (candidate === ours) continue;
    if ((await stat(candidate).catch(() => null)) !== null) found.push(entry.name);
  }
  return found.sort();
}

/**
 * The verdict half of the `Secrets:` line — the path is the caller's to render, because the text report
 * abbreviates it against `$HOME` and `--json` does not. `null` when there is nothing to add: a file
 * that is there and a config directory with nothing else in it need no sentence at all.
 */
export function describeDevSecretsLocation(check: DevSecretsLocationCheck): string | null {
  if (check.present) return null;
  if (check.orphans.length === 0) return "no file yet; pithy add mints one when a capability needs it";
  // Named rather than diagnosed. This cannot tell a rename from two unrelated projects on one machine,
  // and guessing which would be worse than listing what is there and letting the reader recognise it.
  return `no file yet; secrets exist for ${check.orphans.join(", ")} — a renamed project leaves its old name here`;
}
