// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { encodeVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { DEV_SECRETS_FILE, type DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { loadDevSecrets } from "@pithy-sh/secrets/src/dev/loadDevSecrets";
import { storedSecretValue } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
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
 *
 * **And it describes the transition rather than fighting it (#153).** Until dev's read path routes by
 * backend, the seeder copies every `d1` value into `.dev.vars` too — that binding is where dev reads
 * it. This block used to name each of those copies and say "Delete that line", which is the one action
 * that breaks dev, told to every project on the branch that wrote the line. So the three situations are
 * now told apart by comparing the copy with what the seeder would write: pithy's own current copy is
 * explained and is not a fault, a copy that disagrees is one `pithy seed` away, and a secret in
 * `.dev.vars` alone is still the migration notice it always was.
 */

/** Why a declared `d1` secret is sitting in `.dev.vars`. Three states, three different answers. */
export type MisplacedDevSecretState =
  /**
   * pithy put it there, and it matches `.dev.secrets.jsonc` exactly. **Not a fault.** Dev resolves
   * every secret from its injected binding whatever its backend, so the seeder writes this copy on
   * every run and deleting it is the one action that breaks dev before #153 lands.
   */
  | "injected"
  /**
   * Both files carry it and they do not agree — an old hand-written value the move left behind, or a
   * copy from before the file changed. The file is dev's source of truth, and `pithy seed` rewrites
   * this copy from it.
   */
  | "stale"
  /** Only `.dev.vars` has it: the pre-#149 project, with nothing moved yet. The migration notice. */
  | "unmoved";

/** One declared `d1` secret found in `.dev.vars`, and what its being there means. */
export interface MisplacedDevSecret {
  /** The registry secret name, as it appears in both files. */
  name: string;
  /** Which of the three situations this is — they have three different fixes, and one of them is none. */
  state: MisplacedDevSecretState;
}

/** What doctor learned about this project's dev secrets. */
export interface DevSecretsCheck {
  /** The resolved `.dev.secrets.jsonc` path — the answer to "where does this go", file or no file. */
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
      const injected = Object.hasOwn(inDevVars, name) ? inDevVars[name] : undefined;
      if (injected !== undefined && injected !== "") {
        if (entry.backend === "d1")
          misplaced.push({ name, state: misplacedState(entry, name, stated, injected, path) });
        continue;
      }
      // Mintable means the next seed supplies it. Only a value that has to come from somewhere real is
      // something the adopter has to do — and the file, not the store, is dev's source of truth for it.
      if (!Object.hasOwn(stated, name) && !entry.devValue) missing.add(name);
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
    // Nor can it say anything true about `.dev.vars`. Every state below is decided by comparing the copy
    // with the file, and an unparseable file states nothing — so pithy's own injected line, the one thing
    // nobody should touch before #153, fell through to `unmoved` and the report told the adopter to go
    // move it. That is the diagnostic breaking dev over a fault it had already named one line earlier.
    misplaced: unreadable ? [] : misplaced,
    missing: unreadable ? [] : [...missing].sort(),
    undeclared,
    mode,
    unreadable,
  };
}

/**
 * Which of the three situations one `.dev.vars` copy is, decided by comparing it with what the seeder
 * would write — the encoded envelope, byte for byte. Equal means pithy wrote it, on some `pithy dev`
 * or `pithy add`, and it is current.
 *
 * Never throws. A file value the registry rejects (a `json` secret whose shape is wrong) cannot be
 * encoded, and that is `stale` rather than a crashed diagnostic: something is out of step, and the
 * seeder is where it gets said properly.
 */
function misplacedState(
  entry: SecretRegistryEntry,
  name: string,
  stated: DevSecretsFile,
  injected: string,
  path: string,
): MisplacedDevSecretState {
  const envelope = Object.hasOwn(stated, name) ? stated[name] : undefined;
  if (!envelope) return "unmoved";
  try {
    return encodeVersionedValue(storedSecretValue(entry, name, envelope, path)) === injected ? "injected" : "stale";
  } catch {
    return "stale";
  }
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
  // An `injected` copy is not among them. pithy writes it, every run, deliberately — counting the
  // toolchain's own transitional bookkeeping as a fault would drag every project on this branch verbose
  // forever, over the one thing nobody should touch.
  return check.misplaced.every((secret) => secret.state === "injected") && !check.unreadable && !wideOpen(check.mode);
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
  for (const { name, state } of check.misplaced) {
    lines.push(describeMisplaced(name, state));
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

/**
 * The one sentence for each state — and the reason this is three sentences rather than two.
 *
 * The `injected` line used to read "Dev reads the .dev.vars one. Delete that line.", said about a copy
 * **pithy had written itself**. That is the diagnostic telling every project on this branch to do the
 * one thing that breaks dev before #153 lands, in the same run that put the line there. A diagnostic
 * that argues with its own toolchain is worse than one that says nothing.
 */
function describeMisplaced(name: string, state: MisplacedDevSecretState): string {
  switch (state) {
    case "injected":
      return `${name} is also in .dev.vars, injected by pithy: dev resolves every secret from its binding until #153. Leave it — ${DEV_SECRETS_FILE} is the source of truth.`;
    case "stale":
      return `${name} is in both .dev.vars and ${DEV_SECRETS_FILE}, and they disagree. Run pithy seed — it rewrites the .dev.vars copy from the file.`;
    case "unmoved":
      return `${name} is in .dev.vars. It belongs in ${DEV_SECRETS_FILE} as { "currentVersion": "1", "versions": { "1": <value> } }.`;
  }
}
