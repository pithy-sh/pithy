// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { isProvisionedBinding } from "@pithy-sh/core/src/capability/bindings";
import type { DevSecret } from "@pithy-sh/core/src/capability/devSecret";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { mintDevValue } from "@pithy-sh/secrets/src/devValue";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { SECRETS_CAPABILITY } from "@pithy-sh/secrets/src/manager/dispatcher";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { upsertDevVars } from "../project/devVars";

export interface AddBootstrapOptions {
  /**
   * The project root — owner of the one shared `.dev.vars` every worker symlinks to, so a value written
   * here reaches every worker at once. The Worker directory would be the wrong file: it is a symlink,
   * and a project with two workers would get two divergent keys.
   */
  projectDir: string;
  /** The manifest of the capability just wired — the authority on which bindings it needs. */
  manifest: CapabilityManifest;
}

/**
 * Finish `pithy add` for the values `add` itself cannot write, and say plainly what is left.
 *
 * Two kinds of gap, and only one of them is loud. A **binding** `add` cannot write — a Secrets Store
 * entry, a Workflow, a Vectorize index — makes the Worker refuse its first request naming what is
 * absent. A **registry secret** is read lazily, so the app boots healthy, `/health` is green, and the
 * failure arrives at the first sign-in or the first tracked link as `secrets/not_found` on a name the
 * adopter has never heard of. Both are handled here: where a *dev* value can be minted honestly, it is
 * minted; where it cannot, the command names the provision command that creates it — at the moment the
 * adopter is thinking about the capability rather than in a doc they read later.
 *
 * Returns the lines to print (`AddResult.notes`), in order. Nothing here ever prints a value.
 */
export async function bootstrapAdd({ projectDir, manifest }: AddBootstrapOptions): Promise<string[]> {
  const notes: string[] = [];
  for (const binding of manifest.requiredBindings) {
    // Optional bindings are skipped for the same reason `validateBindings` skips them: nothing refuses
    // a request over one, so a note would send the adopter provisioning what their app never asks for.
    if (binding.optional || !isProvisionedBinding(binding.type)) continue;
    if (isMasterKey(manifest, binding)) notes.push(...(await ensureDevMasterKey(projectDir)));
    else notes.push(provisionNote(manifest.name, binding));
  }
  notes.push(...(await ensureDevSecrets(projectDir, manifest.devSecrets)));
  return notes;
}

/** The secrets capability's master-key binding — the one provisioned binding with an honest dev value. */
function isMasterKey(manifest: CapabilityManifest, binding: BindingSpec): boolean {
  return manifest.name === SECRETS_CAPABILITY && binding.name === MASTER_KEY_BINDING;
}

/**
 * What a binding needs that only provisioning can supply. `pithy <capability> provision` is the command
 * in every case — each capability that owns provisioned resources subcommands its own name.
 */
function provisionNote(capability: string, binding: BindingSpec): string {
  return `${binding.name} is created by pithy ${capability} provision. Nothing local stands in for it.`;
}

/**
 * Mint this project's dev master key into `.dev.vars`, unless one is already there.
 *
 * **A fresh key per project, never a literal.** One key shipped in a template is one key across every
 * adopter, and the first person to copy it into a deployed environment hands everyone else their
 * secrets. `initialMasterKeyConfig` generates one.
 *
 * **Only when absent** — the same rule `ensureMasterKey` states for the provisioned key. Replacing the
 * key orphans every secret already stored under it, and re-running `pithy add secrets` must be a no-op.
 * An *empty* value is treated as absent: nothing could have been encrypted under it, so there is
 * nothing to orphan, and leaving it would leave `pithy dev` refusing every request.
 *
 * **`.dev.vars`, never `.dev.vars.example`.** The former is gitignored; the latter is committed, and a
 * key written into it is a key in the repository.
 */
async function ensureDevMasterKey(projectDir: string): Promise<string[]> {
  const path = join(projectDir, ".dev.vars");
  const existing = parseDevVars(await readFile(path, "utf8").catch(() => ""));
  if (existing[MASTER_KEY_BINDING]) {
    return [`${MASTER_KEY_BINDING} is already in .dev.vars. Left as it is — a new key orphans every stored secret.`];
  }
  // Stringified, because that is the shape the binding has in a deployed worker too: the Secrets Store
  // holds the same JSON, and `resolveEncryptionConfig` parses one string in both places.
  await upsertDevVars(path, { [MASTER_KEY_BINDING]: JSON.stringify(await initialMasterKeyConfig()) });
  return [
    `Minted a dev master key into .dev.vars as ${MASTER_KEY_BINDING}. Local only.`,
    "Deployed environments get theirs from pithy secrets provision.",
  ];
}

/**
 * Mint a dev value for every secret this capability declares as generatable, unless one is already there.
 *
 * **The capability decides, not this file.** Each value comes from a `devSecrets` entry the capability
 * ships in its own manifest, mirroring the `devValue` on the registry entry that owns the secret. A
 * list of names here would drift the moment a capability shipped another one — and drift silently,
 * because a missing lazily-read secret is invisible until the code path that reads it runs.
 *
 * **Only when absent.** A session secret replaced is every live session invalidated; a link-signing key
 * replaced is every link already in an inbox broken. An *empty* value counts as absent — nothing was
 * signed with it, and leaving it would leave the read failing.
 *
 * **`.dev.vars`, never `.dev.vars.example`.** The former is gitignored; the latter is committed.
 *
 * One write for the whole set, so a capability declaring several either lands them all or lands none.
 */
async function ensureDevSecrets(projectDir: string, declared: readonly DevSecret[]): Promise<string[]> {
  if (declared.length === 0) return [];
  const path = join(projectDir, ".dev.vars");
  const existing = parseDevVars(await readFile(path, "utf8").catch(() => ""));
  const minted: Record<string, string> = {};
  const notes: string[] = [];
  for (const secret of declared) {
    if (existing[secret.name]) {
      notes.push(
        `${secret.name} is already in .dev.vars. Left as it is — a new value invalidates what the old one signed.`,
      );
      continue;
    }
    // The name is the `.dev.vars` key: local dev resolves every secret from its injected string,
    // whatever the registry backend says, so the key is the registry name and not a binding name.
    minted[secret.name] = mintDevValue(secret.devValue);
    notes.push(
      `Minted a dev ${secret.name} into .dev.vars. Local only.`,
      `Deployed environments need pithy secrets create ${secret.name}.`,
    );
  }
  if (Object.keys(minted).length > 0) await upsertDevVars(path, minted);
  return notes;
}
