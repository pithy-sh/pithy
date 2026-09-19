// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { mintSecretValue } from "@pithy-sh/secrets/src/mintValue";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { SystemSecretsStore, storedSecretNames } from "@pithy-sh/secrets/src/store/systemSecretsStore";
import { managerMintedSecrets } from "../capabilities/mintSecrets";
import type { SecretsStore } from "../provision/store";

/**
 * **A feature's own secrets: created once, at `pithy provision --feature`, in the feature's own Cloudflare
 * stores — and nowhere else (#643).**
 *
 * A deployed Worker reads a `d1` secret from an encrypted row in its own `SECRETS` database, sealed under the
 * master key its `SECRETS_ENCRYPTION_KEYS` binding resolves. A declared environment's rows are written by its
 * secrets manager Worker. A feature has no manager, deliberately (#241), so nothing wrote them, and every
 * sign-in on a feature deployment answered `secrets/not_found`.
 *
 * ## The stores are the only copy
 *
 * Nothing about a secret's value is kept on the machine that provisioned it. With no dev login on a feature,
 * the CLI never needs a value after creating it — the Worker is the one reader. A kept copy was tried, and it
 * was the defect: a second machine with no copy generated new values over the deployed ones, and the first
 * machine then re-sealed every row under a master key the store no longer held.
 *
 * ## Create what is absent, never overwrite what exists, and tolerate a race
 *
 * - **The master key** is created with the store's create-if-absent, so of two runs racing, exactly one
 *   creates it. Only that run ever holds its value, in memory, for the rest of the run.
 * - **Every mintable `d1` secret** is sealed by that run and no other, under the key it just created, with an
 *   insert that leaves any row already there alone. Two runs therefore never seal under two keys, and never
 *   crash on the unique name.
 * - **A run that did not create the key** seals nothing. It reads which rows exist — names only, never a value
 *   — and waits a while for the run that did; a read that fails is a failed run, never "nothing is there".
 *
 * ## The one case that cannot work, stated loudly
 *
 * A master key that exists before this run, beside a `d1` secret that does not. The key is write-only from
 * here, so nothing can seal the missing row under it: a capability that declared a new `d1` secret after the
 * feature was provisioned, or a run that created the key and died before sealing. The run refuses, names the
 * secret and the store entry, and says how to start the feature's secrets over. A kept copy of the key would
 * have made this case work and every other case wrong, which is the trade this module declines.
 */

/** What a feature run found or did about its master key. */
export type FeatureMasterKey =
  /** This run created it. Its value is this run's alone, and only for this run. */
  | { state: "created"; text: string }
  /** It was there before this run asked. Nobody here can read it. */
  | { state: "present" }
  /** It was absent when asked, and another run created it before this one's create landed. */
  | { state: "concurrent" };

/**
 * Create the feature's master key if it is absent, and say who created it.
 *
 * Asked before generated, so a re-run makes no key material at all. Created through the store's
 * create-if-absent, so a race has one winner and the loser learns it.
 */
export async function ensureFeatureMasterKey(options: {
  store: SecretsStore;
  entry: string;
}): Promise<FeatureMasterKey> {
  if (await options.store.exists(options.entry)) return { state: "present" };
  const text = JSON.stringify(await initialMasterKeyConfig());
  return (await options.store.create(options.entry, text)) ? { state: "created", text } : { state: "concurrent" };
}

/** What sealing a feature's `d1` secrets did. Names only, never a value. */
export interface SealedFeatureSecrets {
  /** Every mintable `d1` secret the feature's `SECRETS` database holds after this run. */
  sealed: string[];
  /** Of those, the ones this run wrote. Empty on every run after the first. */
  written: string[];
  /**
   * Rows this run replaced because the master key it had just created could not have sealed them: they were
   * sealed under a key the store no longer holds, so no Worker could open them. Empty unless the key was
   * removed and created again.
   */
  resealed: string[];
}

/**
 * How long a run that did not create the master key waits for the run that did to seal the rows. Twelve looks,
 * five seconds apart: a sealing run takes seconds, and a minute is long enough to be sure one is not coming.
 */
export interface SealPatience {
  /** How many times the rows are looked for before the run refuses. At least one. */
  attempts: number;
  /** The wait between two looks, in milliseconds. */
  delayMs: number;
}

/** The default {@link SealPatience}. */
export const SEAL_PATIENCE: SealPatience = { attempts: 12, delayMs: 5_000 };

/**
 * Seal every mintable `d1` secret the registry declares into the feature's `SECRETS` database — only from the
 * run that created the master key, and only what is absent.
 *
 * Through `SystemSecretsStore`, the reader the Worker itself uses, so what it decrypts is what this sealed by
 * construction. Call it once the schema is migrated: the rows live in a table the migration creates.
 *
 * **A run that did not create the key waits, then refuses.** It cannot tell a run that is sealing right now from
 * one that died before sealing, so it looks again for a while — a concurrent provision finishes in that time —
 * and only then says what is missing and why nothing here can make it.
 */
export async function sealFeatureSecrets(options: {
  master: FeatureMasterKey;
  registry: SecretRegistry;
  database: D1Database;
  /** The master key's store entry, named in the refusal so an operator can find it. */
  masterEntry: string;
  /** How long to wait for another run's seal. Defaults to {@link SEAL_PATIENCE}. */
  patience?: SealPatience;
}): Promise<SealedFeatureSecrets> {
  const names = managerMintedSecrets(options.registry);
  if (names.length === 0) return { sealed: [], written: [], resealed: [] };
  // Names only, and a failure propagates: a read that failed is never read as a row that is absent.
  const present = await storedSecretNames(options.database, names);

  if (options.master.state === "created") {
    const store = await SystemSecretsStore.fromEnv({
      SECRETS: options.database,
      SECRETS_ENCRYPTION_KEYS: options.master.text,
    });
    const written: string[] = [];
    const resealed: string[] = [];
    for (const name of names) {
      const entry = options.registry[name];
      if (entry?.devValue === undefined) continue;
      const value = initialVersionedValue(mintSecretValue(entry.devValue));
      if (!present.has(name)) {
        if (await store.create(name, value, entry.valueType)) written.push(name);
        continue;
      }
      // A row that was there before this run created the key was sealed under another key, one the store no
      // longer holds, so no Worker could open it. Replacing it overwrites nothing anybody can read.
      await store.put(name, value, entry.valueType);
      resealed.push(name);
    }
    return { sealed: names, written, resealed };
  }

  const patience = options.patience ?? SEAL_PATIENCE;
  let absent = names.filter((name) => !present.has(name));
  for (let look = 1; absent.length > 0 && look < patience.attempts; look += 1) {
    await new Promise((resolve) => setTimeout(resolve, patience.delayMs));
    const now = await storedSecretNames(options.database, absent);
    absent = absent.filter((name) => !now.has(name));
  }
  if (absent.length > 0) throw unsealableSecrets(absent, options.masterEntry);
  return { sealed: names, written: [], resealed: [] };
}

/**
 * The refusal for the one case the stores alone cannot answer: a master key that exists, beside a `d1` secret
 * that does not. See the module comment for how it arises and why no copy is kept to answer it.
 */
function unsealableSecrets(absent: readonly string[], masterEntry: string): ConflictError {
  const list = absent.join(", ");
  return new ConflictError({
    message: `This feature's master key exists and ${list} ${absent.length === 1 ? "does" : "do"} not. Nothing can seal ${absent.length === 1 ? "it" : "them"}: the key cannot be read back.`,
    action: `If another pithy provision --feature is running for this branch, let it finish and run this again. Otherwise delete the Secrets Store entry ${masterEntry} and run pithy provision --feature again. That starts this feature's secrets over, and signs everyone out of it.`,
    detail: `feature d1 secrets absent under an existing master key ${masterEntry}: ${list}`,
  });
}
