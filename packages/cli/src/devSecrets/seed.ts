// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import { encodeVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import type { DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { mintMissingDevSecrets, seedDevSecrets, storedSecretValue } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { aggregateSecretRegistries } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { loadWorkerConfig, type WorkerConfig } from "../project/config";
import { resolveWorkers } from "../project/workerScope";
import { writeDevVars } from "./devVars";
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
 *
 * **And every seeded value is injected into `.dev.vars` as well — a transition, deleted by #153.**
 * `secretsStore` resolves *every* secret from its injected binding in dev, whatever the registry says
 * its `backend` is (`packages/secrets/src/secretsStore.ts`), while the deployed branch routes by
 * backend. So a `d1` value that only reaches the local `SECRETS` store reaches nowhere dev looks: a
 * fresh `pithy init` + `pithy add auth` + `pithy dev` answered
 * `{"code":"secrets/not_found","message":"Secret binding 'auth-session-secret' is not configured."}`
 * on the first sign-in with the row sitting seeded and unread. Until dev routes by backend, the file
 * is the source of truth, the store is seeded from it, **and** the value is injected — all three, not
 * a choice among them. #153 collapses the two read paths and removes the injection in the same commit;
 * nothing here is the intended shape.
 *
 * **The injection goes through {@link writeDevVars}, which is what makes it arrive.** Writing the
 * project root's `.dev.vars` is not the same as reaching the Worker: `pithy dev` runs wrangler with
 * `cwd: apps/<worker>`, and only `pithy feature` and `pithy worker add` ever link that file into a
 * Worker directory. On a plain project the dual-write landed in a file nothing reads, which is the
 * regression it exists to prevent, moved rather than fixed.
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
  /**
   * Secrets written into `.dev.vars` this run. Two reasons, one list: a `cf-secrets-store` secret
   * belongs there permanently (there is no local Secrets Store), and a `d1` secret is copied there
   * for the transition, because dev still resolves it from that binding. #153 leaves only the former.
   */
  devVars: string[];
  /** Declared secrets with no value and nothing honest to mint. The adopter supplies these. */
  missing: string[];
  /** Names in the file that no Worker's registry declares. Reported, never fatal. */
  undeclared: string[];
  /** Workers whose local store could not be opened, and the one thing each needs. */
  skipped: { worker: string; reason: string }[];
  /**
   * Why a minted value was not written to `.dev.secrets.jsonc` — a project whose `.gitignore` cannot be
   * made to cover it. One sentence naming what to add, never a value. `null` when nothing stood in the way.
   *
   * A real run always sets it. Optional so the report doubles that only assert on `seeded` or `skipped`
   * stay valid — the same reason a discovered Worker's `dev` block is optional.
   */
  refused?: string | null;
  /**
   * One sentence per value no `.dev.vars` quoting survives — see `encodeDevVarsValue`. Never a
   * value. The secret is still in `.dev.secrets.jsonc` and still seeded into the store; what is refused
   * is the transitional copy, which is the only half dev reads until #153.
   */
  devVarsRefused?: string[];
  /**
   * Worker directories holding a `.dev.vars` of their own. wrangler reads *that* file, so the injected
   * copy does not reach them, and their file is theirs to keep — so it is said out loud, never replaced.
   */
  shadowed?: string[];
}

/** What {@link seedProjectDevSecrets} needs. Both seams default to the real project. */
export interface SeedProjectDevSecretsOptions {
  /** The project root — owner of `.dev.secrets.jsonc`, `.dev.vars`, and the `.wrangler/state` stores. */
  projectDir: string;
  /** The Workers to seed for. Defaults to every Worker in `apps/` that composes the secrets capability. */
  targets?: DevSecretsTarget[];
  /** Seam: open one Worker's local store. Defaults to the real Miniflare-backed one. */
  openStore?: (options: OpenDevSecretsStoreOptions) => Promise<DevSecretsStoreHandle>;
  /**
   * Re-import every `pithy.config.ts` before deriving targets — see {@link DevSecretsTargetsOptions}.
   * Ignored when `targets` is supplied, which is already an answer about the composition.
   */
  reload?: boolean;
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
export async function devSecretsTargets(
  projectDir: string,
  options: DevSecretsTargetsOptions = {},
): Promise<DevSecretsTarget[]> {
  const workers = await resolveWorkers({
    projectDir,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
    ...(options.reload ? { loadConfig: reloadWorkerConfig } : {}),
  }).catch(() => []);
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

/** How {@link devSecretsTargets} narrows and how it loads. Both default to the whole project, cached. */
export interface DevSecretsTargetsOptions {
  /** Narrow to one Worker, by the name `pithy worker list` shows or its `apps/<dir>` basename. */
  worker?: string;
  /**
   * Re-import each `pithy.config.ts` rather than taking the module this process already holds.
   *
   * For **`pithy add`, and only for it.** That command rewrites the Worker's config and then seeds, in
   * one process that imported the config before the write — so the aggregate registry it seeds against
   * is the composition from *before* the add, and the secret the same run has just minted never
   * reaches the store. The next unrelated command picked it up, which made it look like a store
   * problem rather than a stale module.
   *
   * Off by default because it is not free: every reload adds a module instance to the ESM registry for
   * the life of the process, and re-runs the config's top-level code. `pithy dev` and `pithy seed` load
   * the config once and never rewrite it, so they have nothing stale to correct.
   */
  reload?: boolean;
}

/** Distinguishes one reload from the next, so two in a process both get a module and not the first one twice. */
let reloadCount = 0;

/**
 * One Worker's `pithy.config.ts`, imported past the ESM module cache with a query the resolver ignores
 * and the cache key does not.
 *
 * **The specifier is the absolute path, not `pathToFileURL`, and that is load-bearing under Bun.** Bun
 * honours the query as part of the cache key for a path specifier and ignores it for a `file://` URL:
 * `import("/abs/pithy.config.ts?v=2")` re-evaluates, `import("file:///abs/pithy.config.ts?v=2")` hands
 * back the first instance. The URL form is what {@link loadWorkerConfig} uses and is right there — it
 * *wants* the cache. Written the same way here, `pithy add auth` seeded nothing and said nothing about
 * it, because the fallback below silently returned the stale module. Vitest's module runner busts on
 * either form, so no unit test can tell the two apart; the CLI itself was what caught it.
 *
 * Every failure falls back to {@link loadWorkerConfig}, which owns the two actionable errors — a config
 * that is absent, and one that will not import — so nothing here has to restate them, and a config that
 * loads clean but exports the wrong shape is answered by the same message it always was.
 */
async function reloadWorkerConfig(workerDir: string): Promise<WorkerConfig> {
  const path = join(workerDir, "pithy.config.ts");
  reloadCount += 1;
  const module = await import(`${path}?pithy-reload=${reloadCount}`).catch(() => null);
  const config: unknown = module?.default;
  if (config === null || typeof config !== "object" || !Array.isArray((config as WorkerConfig).capabilities)) {
    return loadWorkerConfig(workerDir);
  }
  return config as WorkerConfig;
}

/** Seed the project's dev secrets. Throws only when the file itself is malformed — that is the boundary. */
export async function seedProjectDevSecrets(options: SeedProjectDevSecretsOptions): Promise<DevSecretsSeedReport> {
  const projectDir = options.projectDir;
  const openStore = options.openStore ?? openDevSecretsStore;
  const targets = options.targets ?? (await devSecretsTargets(projectDir, { reload: options.reload === true }));

  const seeded = new Set<string>();
  const unchanged = new Set<string>();
  const missing = new Set<string>();
  const skipped: { worker: string; reason: string }[] = [];
  const devVars: Record<string, string> = {};
  const declared = new Set<string>();
  // The file is read once and carried across Workers. Two Workers that declare one secret must mint it
  // once: the second sees the first's value in this object, and `seedDevSecrets` never mints over one.
  const file = await readDevSecrets(projectDir);
  const inDevVars = parseDevVars(await readFile(join(projectDir, ".dev.vars"), "utf8").catch(() => ""));

  const minted = new Set<string>();
  let refused: string | null = null;

  for (const target of targets) {
    for (const name of Object.keys(target.registry)) declared.add(name);

    const handle = await openStore({ projectDir, workerDir: target.dir, worker: target.name });
    if (!handle.ready) {
      skipped.push({ worker: target.name, reason: handle.reason });
      continue;
    }
    const declaredHere = notYetMoved(target.registry, file, inDevVars);
    try {
      // **Persist before storing.** A minted value written to D1 before it reaches
      // `.dev.secrets.jsonc` is a row nothing explains: the next run finds the file still without it,
      // mints a *different* value, and overwrites the row — for a session secret, every live session
      // invalidated on every `pithy dev`, for as long as the file write keeps failing. And a failing
      // file write is exactly the state that produced it. This way a failed write costs a value that
      // never existed anywhere, and the store is left holding the last one that did.
      const fresh = mintMissingDevSecrets(file, declaredHere);
      const written = await writeDevSecrets(projectDir, fresh);
      refused = refused ?? written.refused;
      for (const name of written.added) {
        const envelope = fresh[name];
        if (!envelope) continue;
        file[name] = envelope;
        minted.add(name);
      }

      // Nothing minted here is seeded unless it landed. Both `file` and the registry are narrowed, so
      // `seedDevSecrets` has nothing left to mint and this is the only place a mint can happen.
      const registry = seedable(declaredHere, file);
      const result = await seedDevSecrets({
        file,
        registry,
        store: handle.store,
        path: devSecretsPath(projectDir),
      });
      for (const name of result.seeded) seeded.add(name);
      for (const name of result.unchanged) unchanged.add(name);
      for (const name of result.missing) missing.add(name);
      for (const [name, value] of Object.entries(result.devVars)) devVars[name] = value;
      // TRANSITION (#153). Everything this Worker resolved now also goes into `.dev.vars`, because
      // that binding — not the row just written — is where dev reads it. Driven off `seeded` and
      // `unchanged` so it covers exactly what the store holds, on the first run and on every re-run.
      for (const name of [...result.seeded, ...result.unchanged]) {
        const line = injectedValue(registry, name, file, devSecretsPath(projectDir));
        if (line !== null) devVars[name] = line;
      }
    } finally {
      await handle.dispose();
    }
  }

  // One writer, because a `.dev.vars` line has two ways of not arriving and both are silent: a value
  // dotenv reads differently than it was written, and a file the Worker's wrangler never opens.
  const wrote = await writeDevVars({ projectDir, values: devVars });

  // No target is no registry, and no registry is nothing to judge a name against. Calling every secret
  // in the file undeclared because this project has not composed `secrets` yet is a false statement, and
  // `pithy add auth` made it about the value it had just minted itself.
  const undeclared = targets.length === 0 ? [] : Object.keys(file).filter((name) => !declared.has(name));
  return {
    seeded: sorted(seeded),
    unchanged: sorted(unchanged),
    // What the write actually landed, never what was minted into memory. A refused write minted values
    // that reached no file, and reporting them as minted is how a command claims a value it does not have.
    minted: sorted(minted),
    // What the write landed, never what was handed to it — a value no quoting survives is refused, and
    // reporting it as written is how a command claims a binding the Worker does not have.
    devVars: wrote.written,
    // A secret one Worker cannot mint may be another's to seed. Only the ones nothing supplied are missing.
    missing: sorted(missing).filter((name) => !seeded.has(name) && !unchanged.has(name)),
    undeclared: undeclared.sort(),
    skipped,
    refused,
    devVarsRefused: wrote.refused,
    shadowed: wrote.shadowed,
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
/**
 * **TRANSITION (#153).** One secret's `.dev.vars` line: the stored envelope, encoded — byte for byte
 * what the local `SECRETS` row holds, and what `decodeInjectedValue` round-trips without the
 * bare-string fallback. The bare current value would resolve too, and would silently drop every other
 * version, so dev would disagree with the store the moment a secret had two.
 *
 * `null` when the name is not this registry's to inject, which is not a fault: `seedDevSecrets` reports
 * across the whole run, and a second Worker's secret is that Worker's line to write.
 *
 * This function goes when dev's read path routes by backend. Nothing else here depends on it.
 */
function injectedValue(registry: SecretRegistry, name: string, file: DevSecretsFile, path: string): string | null {
  const entry = registry[name];
  const envelope = file[name];
  if (!entry || !envelope) return null;
  return encodeVersionedValue(storedSecretValue(entry, name, envelope, path));
}

/**
 * The registry minus every mintable secret the file still does not carry — the entries whose write was
 * refused. Dropping them is what stops `seedDevSecrets` from minting a second value and storing it: a
 * row whose value exists in no file is the one outcome minting-before-persisting produced.
 *
 * A no-op on every ordinary run, where the write landed and every mintable name is in the file.
 */
function seedable(registry: SecretRegistry, file: DevSecretsFile): SecretRegistry {
  const entries = Object.entries(registry).filter(
    ([name, entry]) => !entry.devValue || entry.keyed || Object.hasOwn(file, name),
  );
  return Object.fromEntries(entries) as SecretRegistry;
}

function notYetMoved(
  registry: SecretRegistry,
  file: DevSecretsFile,
  inDevVars: Record<string, string>,
): SecretRegistry {
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a secret named for an
  // `Object.prototype` key would read as stated in the file when the file is empty.
  const entries = Object.entries(registry).filter(([name]) => Object.hasOwn(file, name) || !inDevVars[name]);
  return Object.fromEntries(entries) as SecretRegistry;
}

/** A set as a sorted array — every list in the report is ordered, so a run reads the same twice. */
function sorted(names: Set<string>): string[] {
  return [...names].sort();
}
