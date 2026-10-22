// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { EncryptionConfig } from "@pithy-sh/core/src/crypto/envelope";
import { masterKeyRegistryEntry } from "@pithy-sh/secrets/src/capability";
import { initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { StatePathOptions } from "../notifier/state";
import { readBootstrapVars } from "./bootstrapVars";
import { readDevVarsSource } from "./devVars";
import { readDevSecrets, writeDevSecrets } from "./file";
import { resolveDevSecretsFile } from "./location";

/**
 * **The dev master key, settled: one decision for `pithy add secrets` and `pithy setup` (#764).**
 *
 * Both put a project's dev master key into the dev secrets file when it is absent, and both have to make
 * the same three calls in the same order: a key the file states is left alone, a key an older home holds
 * is carried over, and only a project with neither gets a fresh one. Two copies of that is how one command
 * comes to mint where the other adopts, and a minted key where one already existed orphans every secret
 * the old one encrypted, with no error that names the cause.
 *
 * **A fresh key per project, never a literal.** One key shipped in a template is one key across every
 * adopter. `initialMasterKeyConfig` generates one.
 *
 * **An empty value is treated as absent.** Nothing could have been encrypted under it, so there is nothing
 * to orphan, and leaving it would leave the local store unopenable.
 *
 * **Both older homes are read, in the order they were used.** `dev.json` since #154, the project root's
 * `.dev.vars` before it. The `.dev.vars` read goes through the writer's own reader, where only `ENOENT` is
 * "no key here": an unreadable file read as absent is how a second key gets minted. Neither file is ever
 * rewritten.
 */

/** What settling the master key did, or under `dryRun` would do. */
export type MasterKeyOutcome =
  /** The dev secrets file already states one. Nothing written. */
  | { readonly state: "present"; readonly path: string }
  /** No key anywhere on this machine, so a fresh one was minted into the file. */
  | { readonly state: "minted"; readonly path: string }
  /** An older home held a valid key, and it was carried into the file as it stands. */
  | { readonly state: "adopted"; readonly path: string }
  /** An older home holds a value that is not a master key. Nothing adopted, nothing minted. */
  | { readonly state: "invalid"; readonly path: string };

/** What {@link settleDevMasterKey} needs. */
export interface SettleMasterKeyOptions {
  /** Decide and write nothing — the answer `--dry-run` plans from. */
  dryRun?: boolean;
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test writes its own. */
  paths?: StatePathOptions;
}

/**
 * Put this project's dev master key into the dev secrets file, unless one is there — or, under `dryRun`,
 * say what that would do and write nothing.
 *
 * Throws only where the secrets file itself cannot be located or read: a project with no name has no
 * file, and a file that will not parse is not a file to write a key beside.
 */
export async function settleDevMasterKey(
  projectDir: string,
  options: SettleMasterKeyOptions = {},
): Promise<MasterKeyOutcome> {
  const paths = options.paths ?? {};
  const path = await resolveDevSecretsFile(projectDir, paths);
  if ((await readDevSecrets(path))[MASTER_KEY_BINDING]) return { state: "present", path };

  const recorded = (await readBootstrapVars(projectDir, paths))[MASTER_KEY_BINDING];
  const stranded = parseDevVars((await readDevVarsSource(join(projectDir, ".dev.vars"))) ?? "")[MASTER_KEY_BINDING];
  const adopted = firstValue(recorded, stranded);
  // The file states the `EncryptionConfig` itself, and nothing around it (#323). An adopted value arrives
  // as the string a binding carried, so it is parsed back into the object the file holds.
  const config = adopted === undefined ? null : parseConfig(adopted);
  if (adopted !== undefined && config === null) return { state: "invalid", path };
  const state = adopted === undefined ? "minted" : "adopted";
  if (options.dryRun) return { state, path };

  const value = config ?? (await initialMasterKeyConfig());
  const wrote = await writeDevSecrets(path, { [MASTER_KEY_BINDING]: initialDevSecret(masterKeyRegistryEntry, value) });
  // Refused only when the name is already there — written by something else between the read and the write.
  return wrote.length === 0 ? { state: "present", path } : { state, path };
}

/** The first non-empty of the older homes, or `undefined` when this machine has no key at all. */
function firstValue(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) if (candidate !== undefined && candidate !== "") return candidate;
  return undefined;
}

/** A binding's string parsed back into the `EncryptionConfig` the file states, or `null` when it is not one. */
function parseConfig(value: string): EncryptionConfig | null {
  try {
    const parsed = EncryptionConfig.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
