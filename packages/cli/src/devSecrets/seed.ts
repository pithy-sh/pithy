// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import type { DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { seedDevSecrets } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { aggregateSecretRegistries } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { upsertDevVars } from "../project/devVars";
import { resolveWorkers } from "../project/workerScope";
import { devSecretsPath, readDevSecrets, writeDevSecrets } from "./file";
import { type DevSecretsStoreHandle, type OpenDevSecretsStoreOptions, openDevSecretsStore } from "./store";

/**
 * `pithy seed`'s dev-secrets half: take `.dev.secrets.jsonc`, mint what is missing and generatable, and
 * put every declared value where its registry entry says it belongs. The idempotent workhorse `pithy
 * add` and `pithy dev` both call, so there is one seeding path and not three that drift.
 *
 * **The registry decides the destination, per Worker.** Capabilities are per-Worker, so a registry is
 * too, and a `d1` secret goes into *that* Worker's local `SECRETS` store. The file is project-wide,
 * because a secret name is the join key everywhere and two Workers sharing a name share a value.
 *
 * **Nothing here is fatal for a project that has no secrets.** A Worker that never composed the
 * capability contributes no registry; one whose store cannot be opened contributes a reason. Both come
 * back in the report for the caller to print. `pithy dev` must start a project whose secrets are not
 * wired yet — refusing to would make an unrelated capability's missing binding stop every Worker.
 */

/** One Worker's contribution: its name, its directory, and the registry that decides its destinations. */
export interface DevSecretsTarget {
  /** The Worker's name — what a skipped reason names, so the adopter knows which one to fix. */
  name: string;
  /** The Worker's directory; its `wrangler.jsonc` declares the `SECRETS` binding. */
  dir: string;
  /** That Worker's secret registry. */
  registry: SecretRegistry;
}

/** What one seeding run did. Every list is sorted, so two runs of the same state read the same. */
export interface DevSecretsSeedReport {
  /** `d1` secrets written this run — new, or changed in the file since the last run. */
  seeded: string[];
  /** `d1` secrets already stored with the value the file states. Not rewritten. */
  unchanged: string[];
  /** Values minted this run and written back into `.dev.secrets.jsonc`. */
  minted: string[];
  /** `cf-secrets-store` secrets written into `.dev.vars` — there is no local Secrets Store. */
  devVars: string[];
  /** Declared secrets with no value and nothing honest to mint. The adopter supplies these. */
  missing: string[];
  /** Names in the file that no Worker's registry declares. Reported, never fatal. */
  undeclared: string[];
  /** Workers whose local store could not be opened, and the one thing each needs. */
  skipped: { worker: string; reason: string }[];
}

/** What {@link seedProjectDevSecrets} needs. Both seams default to the real project. */
export interface SeedProjectDevSecretsOptions {
  /** The project root — owner of `.dev.secrets.jsonc`, `.dev.vars`, and the `.wrangler/state` stores. */
  projectDir: string;
  /** The Workers to seed for. Defaults to every Worker in `apps/` that composes the secrets capability. */
  targets?: DevSecretsTarget[];
  /** Seam: open one Worker's local store. Defaults to the real Miniflare-backed one. */
  openStore?: (options: OpenDevSecretsStoreOptions) => Promise<DevSecretsStoreHandle>;
}

/**
 * Every Worker in the project that composes `secrets`, with the registry that Worker actually resolves
 * secrets through. A Worker without the capability is not an error and not a target — it has no
 * `SECRETS` store to seed into, so there is nothing to do and nothing to say about it.
 *
 * **The registry is the aggregate, not the secrets capability's own slice.** `aggregateSecretRegistries`
 * is the exact call the Worker makes at composition: every capability contributes the secrets it owns,
 * and `auth-session-secret` is auth's declaration, not something an adopter re-types into
 * `secrets({ registry })`. Reading only the secrets capability's slice seeded nothing in a real project
 * and threw outright in a scaffolded one, where `pithy add secrets` writes `secrets({ rotationIntervalDays })`
 * and leaves `registry` for the adopter — so the slice is `undefined` on a config the CLI itself wrote.
 */
export async function devSecretsTargets(projectDir: string, worker?: string): Promise<DevSecretsTarget[]> {
  const workers = await resolveWorkers({ projectDir, ...(worker !== undefined ? { worker } : {}) }).catch(() => []);
  const targets: DevSecretsTarget[] = [];
  for (const resolved of workers) {
    if (!resolved.capabilities.some(isSecretsCapability)) continue;
    targets.push({
      name: resolved.name,
      dir: resolved.dir,
      registry: aggregateSecretRegistries(resolved.capabilities),
    });
  }
  return targets;
}

/** Seed the project's dev secrets. Throws only when the file itself is malformed — that is the boundary. */
export async function seedProjectDevSecrets(options: SeedProjectDevSecretsOptions): Promise<DevSecretsSeedReport> {
  const projectDir = options.projectDir;
  const openStore = options.openStore ?? openDevSecretsStore;
  const targets = options.targets ?? (await devSecretsTargets(projectDir));

  const seeded = new Set<string>();
  const unchanged = new Set<string>();
  const missing = new Set<string>();
  const skipped: { worker: string; reason: string }[] = [];
  const devVars: Record<string, string> = {};
  const declared = new Set<string>();
  // The file is read once and carried across Workers. Two Workers that declare one secret must mint it
  // once: the second sees the first's value in this object, and `seedDevSecrets` never mints over one.
  const file = await readDevSecrets(projectDir);
  const minted: Record<string, (typeof file)[string]> = {};
  const inDevVars = parseDevVars(await readFile(join(projectDir, ".dev.vars"), "utf8").catch(() => ""));

  for (const target of targets) {
    for (const name of Object.keys(target.registry)) declared.add(name);

    const handle = await openStore({ projectDir, workerDir: target.dir, worker: target.name });
    if (!handle.ready) {
      skipped.push({ worker: target.name, reason: handle.reason });
      continue;
    }
    try {
      const result = await seedDevSecrets({
        file,
        registry: notYetMoved(target.registry, file, inDevVars),
        store: handle.store,
        path: devSecretsPath(projectDir),
      });
      for (const name of result.seeded) seeded.add(name);
      for (const name of result.unchanged) unchanged.add(name);
      for (const name of result.missing) missing.add(name);
      for (const [name, value] of Object.entries(result.devVars)) devVars[name] = value;
      for (const [name, envelope] of Object.entries(result.minted)) {
        minted[name] = envelope;
        file[name] = envelope;
      }
    } finally {
      await handle.dispose();
    }
  }

  // Written after every Worker, not per Worker: a project with two Workers should touch each file once,
  // and a mid-run failure should not leave half a mint on disk with no row to match it.
  await writeDevSecrets(projectDir, minted);
  if (Object.keys(devVars).length > 0) await upsertDevVars(join(projectDir, ".dev.vars"), devVars);

  // No target is no registry, and no registry is nothing to judge a name against. Calling every secret
  // in the file undeclared because this project has not composed `secrets` yet is a false statement, and
  // `pithy add auth` made it about the value it had just minted itself.
  const undeclared = targets.length === 0 ? [] : Object.keys(file).filter((name) => !declared.has(name));
  return {
    seeded: sorted(seeded),
    unchanged: sorted(unchanged),
    minted: Object.keys(minted).sort(),
    devVars: Object.keys(devVars).sort(),
    // A secret one Worker cannot mint may be another's to seed. Only the ones nothing supplied are missing.
    missing: sorted(missing).filter((name) => !seeded.has(name) && !unchanged.has(name)),
    undeclared: undeclared.sort(),
    skipped,
  };
}

/**
 * The registry minus every secret an existing project still keeps in `.dev.vars` and has not stated in
 * `.dev.secrets.jsonc`. Those are the migration case, and this run has nothing honest to do with them.
 *
 * **Minting over one is the bug this exists to stop.** Local dev resolves that value from its injected
 * binding today, so a mint here does not replace it — it adds a second, different value, in a second
 * file, with nothing to say which one signed what. `pithy add` already refuses on exactly this rule; the
 * seeder refusing on a different one meant one `pithy add auth` printed both "left in .dev.vars, nothing
 * was rewritten" and "minted into .dev.secrets.jsonc" about the same secret, and produced both values.
 *
 * **Stated in the file wins.** A name in both files is a value the adopter has moved and not yet deleted
 * the old copy of, so the file is what gets seeded and `pithy doctor` says to delete the `.dev.vars`
 * line. Nothing rewrites their `.dev.vars`; that is theirs.
 */
function notYetMoved(
  registry: SecretRegistry,
  file: DevSecretsFile,
  inDevVars: Record<string, string>,
): SecretRegistry {
  const entries = Object.entries(registry).filter(([name]) => name in file || !inDevVars[name]);
  return Object.fromEntries(entries) as SecretRegistry;
}

/** A set as a sorted array — every list in the report is ordered, so a run reads the same twice. */
function sorted(names: Set<string>): string[] {
  return [...names].sort();
}
