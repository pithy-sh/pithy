// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import type { DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { mintMissingDevSecrets, seedDevSecrets } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { StatePathOptions } from "../notifier/state";
import { writeDevVars } from "./devVars";
import { readDevSecrets, writeDevSecrets } from "./file";
import { resolveDevSecretsFile } from "./location";
import {
  type DevSecretsStoreHandle,
  localDevStorePath,
  type OpenDevSecretsStoreOptions,
  openDevSecretsStore,
} from "./store";
import { type DevSecretsTarget, devSecretsTargets } from "./targets";

/**
 * `pithy seed`'s dev-secrets half: take `<config>/<project>/secrets.jsonc`, mint what is missing and
 * generatable, and put every declared value where its registry entry says it belongs. The idempotent
 * workhorse `pithy add` and `pithy dev` both call, so there is one seeding path and not three that drift.
 *
 * **The input moved out of the checkout; the destinations did not (#156).** The file is resolved from
 * the project's *name*, so every worktree of one project seeds from one file with no setup step — and
 * the local `SECRETS` store, `.dev.vars`, and `.wrangler/state` are all still the project directory's.
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
 * **`.dev.vars` no longer carries application secrets (#153).** #149 had to write every seeded value
 * there as well, because `secretsStore`'s dev branch resolved every secret from its injected binding
 * whatever its backend — so a `d1` value that only reached the local `SECRETS` store reached nowhere dev
 * looked. Dev now routes by backend exactly as deployed does and reads the row this seeder writes, so the
 * dual-write is gone and `.dev.vars` is back to what wrangler says it is: env bindings, `UPPER_SNAKE`,
 * one namespace. The only thing still written there is a `cf-secrets-store` secret, which belongs there
 * permanently — there is no local Secrets Store, and the binding is the only place a Worker can read it.
 *
 * **A registry secret sitting in an adopter's `.dev.vars` is now inert, and this run treats it as
 * absent.** It used to be dev's live value, so minting beside it produced two values with nothing to say
 * which signed what. It signs nothing now. So a mintable secret is minted and seeded — a project that
 * upgrades is not left with a Worker that cannot resolve its session key — and the stranded line is
 * `pithy doctor`'s to name, every run, until it is deleted. Nothing here rewrites their file.
 *
 * **The `cf-secrets-store` write goes through {@link writeDevVars}, which is what makes it arrive.**
 * Writing the project root's `.dev.vars` was never the same as reaching the Worker: `pithy dev` runs
 * wrangler with `cwd: apps/<worker>`, and wrangler loads the file beside the Worker's own config. Each
 * Worker's file is **generated** now (#154), from the machine-local bootstrap store and the
 * `.dev.vars.local` overrides — so there is no link to wire, dangle, delete, or detach, and this seeding
 * run is one of the two commands that regenerate.
 */

/** What one seeding run did. Every list is sorted, so two runs of the same state read the same. */
export interface DevSecretsSeedReport {
  /**
   * The absolute path of the secrets file this run read and minted into.
   *
   * In the report because the file is outside the checkout (#156) and nothing else in the run names
   * it: "minted a dev auth-session-secret" is not actionable if the reader cannot open what it landed
   * in. Optional so report doubles that assert only on `seeded` or `skipped` stay valid.
   */
  path?: string;
  /** `d1` secrets written this run — new, or changed in the file since the last run. */
  seeded: string[];
  /** `d1` secrets already stored with the value the file states. Not rewritten. */
  unchanged: string[];
  /** Values minted this run and written back into the secrets file. */
  minted: string[];
  /**
   * Secrets written into `.dev.vars` this run — `cf-secrets-store` ones, and only those. There is no
   * local Secrets Store, so the binding is the only place a Worker can read one from. A `d1` secret is
   * never here: since #153 dev reads its seeded row, the same as deployed.
   */
  devVars: string[];
  /** Declared secrets with no value and nothing honest to mint. The adopter supplies these. */
  missing: string[];
  /** Names in the file that no Worker's registry declares. Reported, never fatal. */
  undeclared: string[];
  /** Workers whose local store could not be opened, and the one thing each needs. */
  skipped: { worker: string; reason: string }[];
  /**
   * One sentence per value no `.dev.vars` quoting survives — see `encodeDevVarsValue`. Never a value.
   * Only a `cf-secrets-store` secret can be refused now, and the binding is the only place that one is
   * ever read from, so a refusal is a Worker without it. Any superseded line went with it, so the
   * sentence describes a Worker with *no* value rather than one quietly on the old one.
   */
  devVarsRefused?: string[];
  /**
   * Worker directories whose `.dev.vars` was a symlink from the old shared-file design and is now a
   * generated file (#154). A link holds no content, so nothing was lost — but which secrets a Worker
   * runs with did change, so it is never silent.
   */
  relinked?: string[];
}

/** What {@link seedProjectDevSecrets} needs. Both seams default to the real project. */
export interface SeedProjectDevSecretsOptions {
  /** The project root — owner of `.dev.vars` and the `.wrangler/state` stores. Not of the secrets file. */
  projectDir: string;
  /**
   * Where the Pithy config directory is, for {@link resolveDevSecretsFile}. Defaults to the real one:
   * `$PITHY_CONFIG_DIR`, else the platform's. A seam so a test never writes to the operator's own file.
   */
  paths?: StatePathOptions;
  /** The Workers to seed for. Defaults to every Worker in `apps/` that composes the secrets capability. */
  targets?: DevSecretsTarget[];
  /** Seam: open one Worker's local store. Defaults to the real Miniflare-backed one. */
  openStore?: (options: OpenDevSecretsStoreOptions) => Promise<DevSecretsStoreHandle>;
  /**
   * Re-import every `pithy.config.ts` before deriving targets — see {@link DevSecretsTargetsOptions}.
   * Ignored when `targets` is supplied, which is already an answer about the composition.
   */
  reload?: boolean;
  /**
   * **Unsayable on purpose (#159).** No environment, ever, by any spelling.
   *
   * The dev secrets file holds minted random dev values. Seeding it into staging or production would not
   * set some secrets — it would rotate every one at once: every session invalidated, every signed link
   * broken, every OAuth credential replaced with a value the provider has never seen, and no undo,
   * because the values it overwrote were the only copies. A `--force` does not make that safe, it makes
   * it reachable. Production secrets are set one at a time by `pithy secrets provision` and
   * `pithy secrets set`, which know they are touching a live environment.
   *
   * `never` is the strong half of the guarantee: a caller cannot pass the wrong environment because it
   * cannot pass one at all. {@link assertLocalDevStore} is the other half, for the destination a caller
   * *can* still get wrong.
   */
  env?: never;
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
  const declared = new Set<string>();
  // Resolved once, from the project's name rather than its directory (#156) — so every worktree of one
  // project seeds from one file, with no setup step and nothing linked into the checkout. It is also
  // what every note and every error this run raises names, because nothing in the project points at it.
  const path = await resolveDevSecretsFile(projectDir, options.paths ?? {});
  // The file is read once and carried across Workers. Two Workers that declare one secret must mint it
  // once: the second sees the first's value in this object, and `seedDevSecrets` never mints over one.
  const file = await readDevSecrets(path);

  const minted = new Set<string>();

  for (const target of targets) {
    for (const name of Object.keys(target.registry)) declared.add(name);

    const handle = await openStore({
      projectDir,
      workerDir: target.dir,
      worker: target.name,
      ...(options.paths !== undefined ? { paths: options.paths } : {}),
    });
    if (!handle.ready) {
      skipped.push({ worker: target.name, reason: handle.reason });
      continue;
    }
    try {
      // Before a byte is minted or stored. The destination is what makes this a dev seeding run — not
      // the caller's word for it, and not a flag anywhere upstream.
      assertLocalDevStore(projectDir, target.name, handle.persistPath);
      // **Persist before storing.** A minted value written to D1 before it reaches the secrets
      // file is a row nothing explains: the next run finds the file still without it,
      // mints a *different* value, and overwrites the row — for a session secret, every live session
      // invalidated on every `pithy dev`, for as long as the file write keeps failing. And a failing
      // file write is exactly the state that produced it. This way a failed write costs a value that
      // never existed anywhere, and the store is left holding the last one that did.
      const fresh = mintMissingDevSecrets(file, target.registry);
      for (const name of await writeDevSecrets(path, fresh)) {
        const envelope = fresh[name];
        if (!envelope) continue;
        file[name] = envelope;
        minted.add(name);
      }

      // Nothing minted here is seeded unless it landed. Both `file` and the registry are narrowed, so
      // `seedDevSecrets` has nothing left to mint and this is the only place a mint can happen.
      const result = await seedDevSecrets({
        file,
        registry: seedable(target.registry, file),
        store: handle.store,
        path,
      });
      for (const name of result.seeded) seeded.add(name);
      for (const name of result.unchanged) unchanged.add(name);
      for (const name of result.missing) missing.add(name);
      // `result.devVars` is deliberately not consumed here any more (#179). A `cf-secrets-store` value's
      // destination is the generated `.dev.vars`, and the generator reads `secrets.jsonc` itself — the
      // same file this loop has open. Copying it out through this run was what made the dev secrets file
      // stop being the source of the values a Worker receives.
    } finally {
      await handle.dispose();
    }
  }

  // Regenerate every Worker's `.dev.vars` from the sources, carrying **these** targets — the composition
  // this run resolved, which for `pithy add` is the reloaded one. Nothing is recorded on the way: the
  // values are in `secrets.jsonc`, which the generator reads.
  //
  // It runs even when there was nothing to seed, which is what makes a fresh clone's `pithy dev` work
  // with no postinstall and nothing to remember (#139, closed by removal).
  const wrote = await writeDevVars({
    projectDir,
    values: {},
    targets,
    ...(options.paths !== undefined ? { paths: options.paths } : {}),
  });

  // No target is no registry, and no registry is nothing to judge a name against. Calling every secret
  // in the file undeclared because this project has not composed `secrets` yet is a false statement, and
  // `pithy add auth` made it about the value it had just minted itself.
  const undeclared = targets.length === 0 ? [] : Object.keys(file).filter((name) => !declared.has(name));
  return {
    path,
    seeded: sorted(seeded),
    unchanged: sorted(unchanged),
    // What the write actually landed, never what was minted into memory. A refused write minted values
    // that reached no file, and reporting them as minted is how a command claims a value it does not have.
    minted: sorted(minted),
    // What the generated files actually carry, never what was handed to a writer — a value no quoting
    // survives is refused, and reporting it as written is how a command claims a binding the Worker does
    // not have. Narrowed to this project's `cf-secrets-store` secrets, which is what this field means.
    devVars: wrote.names.filter((name) => isBindingSecret(name, targets)),
    // A secret one Worker cannot mint may be another's to seed. Only the ones nothing supplied are missing.
    missing: sorted(missing).filter((name) => !seeded.has(name) && !unchanged.has(name)),
    undeclared: undeclared.sort(),
    skipped,
    devVarsRefused: wrote.refused,
    relinked: wrote.relinked,
  };
}

/** Whether any target's registry declares `name` as a secret a Worker reads from a `.dev.vars` binding. */
function isBindingSecret(name: string, targets: readonly DevSecretsTarget[]): boolean {
  return targets.some(
    (target) => Object.hasOwn(target.registry, name) && target.registry[name]?.backend === "cf-secrets-store",
  );
}

/**
 * Refuse any store that is not this project's own local dev store (#159).
 *
 * **The rule lives here rather than at a call site.** `commands/seed.ts` has guarded it correctly since
 * the day it was written — `env === "dev" && !dryRun` — and that is one caller out of six. Four defect
 * classes in this branch each had three or more producers, every one because the rule was enforced where
 * the thing was called instead of inside the thing being called. This one's payload is every live secret
 * in a production environment, rotated at once, with no copy of what it overwrote.
 *
 * **The destination is asserted, not the intent.** A parameter saying `dev` is a claim; where the rows
 * land is a fact. `openDevSecretsStore` opens Miniflare over {@link localDevStorePath} and reports that
 * path, so a handle bound to a remote D1 — through the `openStore` seam, or a future one — cannot pass.
 *
 * **And an unresolvable destination refuses.** A handle with no path at all is not "probably fine": the
 * permissive default is the whole bug this closes. `undefined` is in the signature and not in the type
 * because the type already forbids it — this is what answers a caller that came from outside TypeScript.
 */
function assertLocalDevStore(projectDir: string, worker: string, persistPath: string | undefined): void {
  const expected = localDevStorePath(projectDir);
  if (persistPath !== undefined && resolve(persistPath) === resolve(expected)) return;
  throw new ConflictError({
    message: `Refusing to seed dev secrets for ${worker}: that is not this project's local dev store.`,
    action:
      "Dev secrets are local only. A deployed environment gets its secrets from pithy secrets provision and pithy secrets set, one at a time.",
    detail: `expected the local dev store at '${expected}'; the handle named ${persistPath === undefined ? "no path at all" : `'${persistPath}'`}`,
  });
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

/** A set as a sorted array — every list in the report is ordered, so a run reads the same twice. */
function sorted(names: Set<string>): string[] {
  return [...names].sort();
}
