// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { sentenceOf } from "@pithy-sh/core/src/error/pithyError";
import { masterKeyRegistryEntry } from "@pithy-sh/secrets/src/capability";
import { type DevSecretsStore, devVarsForRegistry } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { SystemSecretsStore } from "@pithy-sh/secrets/src/store/systemSecretsStore";
import { Miniflare } from "miniflare";
import type { StatePathOptions } from "../notifier/state";
import { resolveStoreIds } from "../seed/drivers";
import { readBootstrapVars } from "./bootstrapVars";
import { readDevSecrets } from "./file";
import { resolveDevSecretsFile } from "./location";

/**
 * The local `SECRETS` D1, opened the way `wrangler dev` opens it — the same Miniflare store under the
 * project root's `.wrangler/state`, so a row seeded here is a row the running Worker reads.
 *
 * **Three things have to be true before a secret can be seeded**, and each is a different fix, so each
 * comes back named rather than as one "seeding failed": the Worker must declare the `SECRETS` binding
 * (`pithy add secrets`), the project must have a dev master key (the same command mints it), and the
 * database must be migrated (`pithy migrate`). None of them is an error — a project that never composed
 * `secrets` is a perfectly good project — so this answers with a reason, and the caller decides whether
 * to print it. `pithy add` and `pithy dev` must not fail over a capability the project does not have.
 */

/**
 * The D1 binding name the secrets store reads through, fixed across environments. It is `SecretsStoreEnv`'s
 * `SECRETS` field and the secrets manifest's required `d1` binding — stated here because this file opens
 * that store from outside a Worker, where neither of those types is in play.
 */
export const SECRETS_D1_BINDING = "SECRETS";

/**
 * Where a project's local dev D1 databases are persisted — the directory `wrangler dev` writes into, and
 * the one thing that makes a store provably *this project's local dev store* rather than something a
 * caller called `dev`.
 *
 * Exported because the seeder asserts against it (#159). It is a destination, not a claim: a handle over
 * a remote D1 cannot name this path and mean it.
 */
export function localDevStorePath(projectDir: string): string {
  return join(projectDir, ".wrangler", "state", "v3", "d1");
}

/** An open local store, or the reason there is none. `dispose` is safe to call either way. */
export type DevSecretsStoreHandle =
  | {
      readonly ready: true;
      /** The store `seedDevSecrets` writes through — the real `SystemSecretsStore` over the local D1. */
      readonly store: DevSecretsStore;
      /**
       * Where rows written through {@link store} actually land. The seeder refuses anything that is not
       * {@link localDevStorePath} for the project it was asked about — see `assertLocalDevStore`.
       *
       * Required, and that is the point: a handle assembled without it does not compile, so a future
       * store seam cannot quietly become a path dev secrets reach a managed environment through.
       */
      readonly persistPath: string;
      readonly dispose: () => Promise<void>;
    }
  | {
      readonly ready: false;
      /** One sentence naming what is missing and the command that supplies it. Never a value. */
      readonly reason: string;
      readonly dispose: () => Promise<void>;
    };

/** What {@link openDevSecretsStore} needs to find the store a Worker would read. */
export interface OpenDevSecretsStoreOptions {
  /**
   * The project root — owner of the `.wrangler/state` Miniflare stores every Worker shares, and of the
   * one `.dev.vars` the dev master key lives in. Never a Worker directory: persistence is project-scoped
   * (see the seed driver), and a per-Worker root would seed a database no Worker opens.
   */
  projectDir: string;
  /** The Worker's directory — its `wrangler.jsonc` declares the `SECRETS` binding and its database id. */
  workerDir: string;
  /** The Worker's name, for the reason text. Defaults to naming no Worker. */
  worker?: string;
  /**
   * **Unsayable on purpose (#159).** There is no environment here, and there must not be one: this opens
   * the project's own Miniflare-backed store and nothing else. `never` means a caller that tries to pass
   * `prod` fails to compile, which is stronger than any check it could fail at runtime.
   */
  env?: never;
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test reads its own. */
  paths?: StatePathOptions;
}

/** Open the local secrets store for one Worker, or say why there is none to open. */
export async function openDevSecretsStore(options: OpenDevSecretsStoreOptions): Promise<DevSecretsStoreHandle> {
  const noop = { dispose: async () => {} };
  const scope = options.worker ? ` --worker ${options.worker}` : "";

  const ids = await resolveStoreIds({ workerDir: options.workerDir, env: "dev" });
  const databaseId = ids.d1.get(SECRETS_D1_BINDING);
  if (!databaseId) {
    return { ready: false, reason: `No ${SECRETS_D1_BINDING} D1 binding. Run pithy add secrets${scope}.`, ...noop };
  }

  // The dev secrets file, which is what the Worker's generated `.dev.vars` is built from (#179) —
  // materialised through the same function the generator uses, so the key this store opens with and the
  // key the running Worker receives cannot be two different strings.
  //
  // **Both older homes are still read, in the order they were used.** `dev.json` is where #154 put it and
  // where an upgrading project still has it; the project root's `.dev.vars` is where it lived before that
  // and still does until `pithy add secrets` adopts it. Reading only the current one would make every
  // project that has not upgraded unopenable — and this is the master key, so an "absent" answer is not a
  // fresh start: it is every secret already encrypted under it becoming unreadable.
  const stated = await statedMasterKey(options.projectDir, options.paths ?? {});
  // **A file that states a key which will not read ends it here, whatever an older home holds (#325).**
  // The fallbacks below are for a file that says nothing, and this file has said something. Reading past
  // it opened the store under the *older* key without a word about the newer claim — and this file is
  // what every Worker's `.dev.vars` is generated from, so the next seed encrypted rows under a key the
  // running Worker is never handed. The only symptom is a decrypt failure, three commands later.
  //
  // Deliberately a refusal rather than a fallback with a warning: nothing in this function prints, and a
  // handle carries one sentence. Refusing is the only answer here that a caller cannot miss.
  if (stated.unreadable) return { ready: false, reason: stated.unreadable, ...noop };

  const masterKey =
    stated.value ||
    (await readBootstrapVars(options.projectDir, options.paths ?? {}))[MASTER_KEY_BINDING] ||
    parseDevVars(await readFile(join(options.projectDir, ".dev.vars"), "utf8").catch(() => ""))[MASTER_KEY_BINDING];
  if (!masterKey) {
    // The sentence for a project with no file to state anything, and only then the absent one. "Not
    // recorded" is a claim about the file, and it may only be made when the file makes no claim (#323) —
    // which includes there being no file to make one.
    const reason = stated.unlocatable ?? `No ${MASTER_KEY_BINDING} recorded. Run pithy add secrets${scope}.`;
    return { ready: false, reason, ...noop };
  }

  const persistPath = localDevStorePath(options.projectDir);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { [SECRETS_D1_BINDING]: databaseId },
    d1Persist: persistPath,
  });
  const dispose = () => miniflare.dispose();

  let store: SystemSecretsStore;
  try {
    // Neither call touches the database — `fromEnv` resolves the master key and wraps the binding — so
    // a failure here is the key, and only the key. Kept apart from the probe below so the two cannot
    // answer for each other: "not migrated" over an unreadable master key sends the adopter to the
    // wrong command, and they run it, and nothing changes.
    store = await SystemSecretsStore.fromEnv({
      SECRETS: (await miniflare.getD1Database(SECRETS_D1_BINDING)) as unknown as D1Database,
      SECRETS_ENCRYPTION_KEYS: masterKey,
    });
  } catch {
    await dispose();
    return { ready: false, reason: `${MASTER_KEY_BINDING} is not a valid master key.`, ...noop };
  }

  try {
    // The probe reads the same table the seeder writes, so "migrated" means migrated for this purpose
    // and not for some adjacent one. An unmigrated database is the ordinary state right after `pithy add
    // secrets`, and `no such table: pithy_secrets_system_secrets` is not an answer anybody can act on.
    await store.listNames();
  } catch {
    await dispose();
    return { ready: false, reason: "The local SECRETS database is not migrated. Run pithy migrate.", ...noop };
  }
  return { ready: true, store, persistPath, dispose };
}

/**
 * What the dev secrets file says about the master key. At most one of the three is set; none of them
 * means a readable file that simply carries no key.
 *
 * **The type is the fix (#323).** A `string | undefined` had one slot for two answers — "the file states
 * nothing" and "the file states something that will not read" — so a bare `catch {}` collapsed them, and
 * a present-but-malformed key printed `No SECRETS_ENCRYPTION_KEYS recorded. Run pithy add secrets.` That
 * sentence is false about a key that is there, and the command it names then does nothing, because
 * `ensureDevMasterKey` finds a key already present and returns. Two investigations died in that gap.
 *
 * **And the fix is one slot short, which is #325.** "The file will not answer" and "there is no file to
 * ask" were still one field, and the caller has to treat them oppositely: the first overrides every older
 * home, because the file is authoritative about a claim it makes; the second overrides nothing, because a
 * project with no name has no file and has made no claim.
 */
interface StatedMasterKey {
  /** The key, materialised exactly as a Worker's binding receives it. Absent when the file has none. */
  readonly value?: string;
  /**
   * Why the file — which is there — could not answer: the thrown error's own sentence.
   *
   * **Authoritative.** The file states a master key and it will not read, so no older home may stand in
   * for it: opening under one encrypts rows under a key this file does not name.
   */
  readonly unreadable?: string;
  /**
   * Why there is no file to ask at all — no project, or a project with no `name`, since the path is
   * resolved from the name.
   *
   * **Not authoritative.** Nothing was stated, so the older homes are still read, and this is only the
   * sentence the caller falls back to when none of them holds a key either.
   */
  readonly unlocatable?: string;
}

/**
 * The master key as the dev secrets file states it, or the sentence saying why it could not be read.
 *
 * Through {@link devVarsForRegistry} and {@link masterKeyRegistryEntry} rather than by reaching into the
 * envelope here: the entry is what says the value is an `EncryptionConfig` and that its binding carries
 * the value rather than the envelope, and a second reading of that in this file is how the seeder and the
 * store come to disagree about what the key is.
 *
 * **Nothing new is written here.** Every reader below already throws a `PithyError` naming the secret,
 * the file, and the fix — `requireProjectName`, `readDevSecretsSource`, `loadDevSecrets`,
 * `storedSecretValue`. The defect was never a missing message; it was a `catch` that threw four of them
 * away. So this carries each one out verbatim, and a fifth reader gets its sentence for free.
 */
async function statedMasterKey(projectDir: string, paths: StatePathOptions): Promise<StatedMasterKey> {
  // Resolved separately from the read, because a path that does not resolve is a different claim: the
  // project has no name, so it has no secrets file, so nothing was ever recorded in one.
  let path: string;
  try {
    path = await resolveDevSecretsFile(projectDir, paths);
  } catch (error) {
    // `unlocatable`, never `unreadable` (#325). There is no file here, so nothing has been stated, and
    // an older home is still the honest place to look for the key.
    return { unlocatable: `No ${MASTER_KEY_BINDING} recorded: ${sentenceOf(error)}` };
  }

  try {
    const file = await readDevSecrets(path);
    const value = devVarsForRegistry(file, { [MASTER_KEY_BINDING]: masterKeyRegistryEntry }, path)[MASTER_KEY_BINDING];
    // An absent key in a readable file is the one state `No … recorded` is true of, so it is the one
    // state that says nothing here and lets the caller's own sentence stand.
    return value === undefined ? {} : { value };
  } catch (error) {
    return { unreadable: sentenceOf(error) };
  }
}
