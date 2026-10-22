// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { FIELD_KEYS_BINDING } from "@pithy-sh/core/src/crypto/fieldKeys";
import { fieldKeysRegistryEntry } from "@pithy-sh/secrets/src/capability";
import { initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { mintMissingDevSecrets } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { readDevSecrets, writeDevSecrets } from "../devSecrets/file";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { settleDevMasterKey } from "../devSecrets/masterKey";
import { type DevSecretsTarget, mergedSecretRegistry, resolveDevSecretsTargets } from "../devSecrets/targets";
import type { StatePathOptions } from "../notifier/state";

/**
 * **`pithy setup`'s third step: the local secrets the kit can mint, minted where they are absent (#764).**
 *
 * The master key, and every secret a registry gives a dev value — a session secret, a link-signing key —
 * into `<config>/<project>/secrets.jsonc`, the one file every checkout of a project on this machine reads.
 * Each only when the file lacks it, so the fifth clone of a project reuses what the first one minted, and a
 * second run writes nothing at all.
 *
 * **It never edits `pithy.config.ts`, which is what makes it not `pithy add secrets`.** That command is run
 * once, by whoever composes the capability, and it wires the capability into a Worker. Every clone after it
 * already has the wiring; what it lacks is the machine-local half, which is all this writes.
 *
 * **It reaches no account.** `pithy add secrets` also records the account's Secrets Store id, which is a
 * question for Cloudflare. A dev run never reads it, so setup never asks.
 *
 * Minted before the store is migrated, on purpose: the seeding run after the migration finds every value
 * already in the file and mints nothing of its own, so there is exactly one place a value is created.
 */

/** What minting did, or under `dryRun` would do. */
export interface MintReport {
  /** The absolute path of the dev secrets file — outside the checkout, so the report names it. */
  path: string;
  /** Secrets minted into it this run, master key first, then by name. */
  minted: string[];
  /** Secrets an older home on this machine held, carried into the file rather than minted. */
  adopted: string[];
  /** A sentence for a master key an older home holds that is not one. Nothing was minted over it. */
  refused: string[];
}

/** What {@link mintLocalSecrets} needs. */
export interface MintLocalSecretsOptions {
  /** The project root. */
  projectDir: string;
  /** Decide, and write nothing. */
  dryRun?: boolean;
  /** The Workers composing `secrets`, with their registries. Defaults to the real project's. */
  targets?: DevSecretsTarget[];
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test writes its own. */
  paths?: StatePathOptions;
}

/** Mint every absent mintable local secret. */
export async function mintLocalSecrets(options: MintLocalSecretsOptions): Promise<MintReport> {
  const paths = options.paths ?? {};
  const path = await resolveDevSecretsFile(options.projectDir, paths);
  const report: MintReport = { path, minted: [], adopted: [], refused: [] };
  const targets = options.targets ?? (await resolveDevSecretsTargets(options.projectDir)).targets;
  // No Worker composes `secrets`: no store to open, no key to open it with, and no registry to mint from.
  if (targets.length === 0) return report;

  const registry = mergedSecretRegistry(targets);
  // The master key only where a Worker composes `secrets`: a Worker that holds an encrypted field and nothing else
  // has no vault to open (#390).
  if (registry[MASTER_KEY_BINDING]) {
    const key = await settleDevMasterKey(options.projectDir, { paths, ...(options.dryRun ? { dryRun: true } : {}) });
    if (key.state === "minted") report.minted.push(MASTER_KEY_BINDING);
    if (key.state === "adopted") report.adopted.push(MASTER_KEY_BINDING);
    if (key.state === "invalid") {
      report.refused.push(
        `${MASTER_KEY_BINDING} is set on this machine but is not a valid master key, so nothing was minted over it. Put a valid one in ${path}.`,
      );
    }
  }

  // The field key, where a Worker holds an encrypted field (#390): a fresh one per project, never a literal, and
  // only when the file lacks it, since a fresh key over an existing one leaves every local sealed field unopenable.
  if (registry[FIELD_KEYS_BINDING] && !(await readDevSecrets(path))[FIELD_KEYS_BINDING]) {
    if (!options.dryRun) {
      await writeDevSecrets(path, {
        [FIELD_KEYS_BINDING]: initialDevSecret(fieldKeysRegistryEntry, await initialMasterKeyConfig()),
      });
    }
    report.minted.push(FIELD_KEYS_BINDING);
  }

  // The same mint `pithy dev`'s seeding run makes, over every Worker's registry at once: a name two Workers
  // declare is one value, minted once.
  const fresh = mintMissingDevSecrets(await readDevSecrets(path), registry);
  const minted = options.dryRun ? Object.keys(fresh) : await writeDevSecrets(path, fresh);
  report.minted.push(...[...minted].sort());
  return report;
}
