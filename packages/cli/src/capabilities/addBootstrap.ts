// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { isProvisionedBinding } from "@pithy-sh/core/src/capability/bindings";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
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
 * Finish `pithy add` for the bindings `add` itself cannot write, and say plainly what is left.
 *
 * `add` writes every binding whose entry is knowable offline. The rest — a Secrets Store entry, a
 * Workflow, a Vectorize index — carry a provisioned value, so the file gets nothing and the Worker
 * refuses its first request naming what is absent. That refusal is right; leaving the adopter to invent
 * the value is not. Where a *dev* value can be generated honestly, it is generated here; where it
 * cannot, the command says which provision command creates it, at the moment the adopter is thinking
 * about the capability rather than in a doc they read later.
 *
 * Returns the lines to print (`AddResult.notes`), in order. Nothing here ever prints a key.
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
