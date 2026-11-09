// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { envStem } from "@pithy-sh/core/src/env/stem";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { OwnedVault } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { readOptionalWranglerConfig } from "../project/wrangler";
import { provisionRemedy } from "../provision/provisionFix";
import { hostOwnerFor, hostWorkerFor } from "./hostRegistry";

/**
 * **The Worker whose own secrets manager a Worker's values belong in**, or `undefined` when it shares the project's
 * manager. One rule, the host rule: a Worker that owns a binding the manager binds — `SECRETS` — keeps its vault in
 * its own database, and only its own manager writes there.
 */
export function secretsOwnerOf(worker: {
  capabilities: readonly ResolvedWorker["capabilities"][number][];
  target: { dir: string; ownBindings?: readonly string[] };
}): string | undefined {
  const spec = hostWorkerFor("secrets");
  const composed = worker.capabilities.find((capability) => capability.name === "secrets");
  if (spec === undefined || composed === undefined) return undefined;
  return hostOwnerFor(spec, composed, worker.target)?.worker;
}

/**
 * **`--worker`, resolved to the manager it writes through.** Absent, the project's shared manager. Named, the Worker
 * must compose `secrets`, and its own manager is used when it owns `SECRETS`; otherwise it reads the shared vault, and
 * the shared manager is the right one.
 */
export async function secretsManagerOwner(
  projectDir: string,
  worker: string | undefined,
  resolve: typeof resolveWorkers = resolveWorkers,
): Promise<string | undefined> {
  if (worker === undefined) return undefined;
  const [resolved] = await resolve({ projectDir, worker });
  if (resolved === undefined || !resolved.capabilities.some((capability) => capability.name === "secrets")) {
    throw new ValidationError({
      message: `${worker} does not compose secrets.`,
      action: `Name a Worker that composes secrets. ${pithyCommand("worker list")} shows them.`,
    });
  }
  return secretsOwnerOf(resolved);
}

/** One environment's stanza, as far as its D1 bindings go. */
interface D1Stanza {
  d1_databases?: { binding?: string; database_name?: string; database_id?: string }[];
}

/** Whether a `database_id` is one wrangler would deploy against, by the rule every readiness check uses. */
function isId(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== "" && !/^<.+>$/.test(trimmed) && !/placeholder/i.test(trimmed);
}

/** The binding the shared manager reads a Worker's own vault through: `VAULT_<OWNER>`. */
export function ownedVaultBinding(owner: string): string {
  return `VAULT_${envStem(owner)}`;
}

/** A Worker's own vault, as its stanza for one environment names it, or `undefined` when the stanza gives no id. */
export function ownedVaultOf(owner: string, stanza: D1Stanza | undefined): OwnedVault | undefined {
  const entry = (stanza?.d1_databases ?? []).find((one) => one.binding === "SECRETS");
  if (!entry || !isId(entry.database_id)) return undefined;
  return {
    binding: ownedVaultBinding(owner),
    databaseName: entry.database_name ?? ownedVaultBinding(owner),
    databaseId: entry.database_id,
  };
}

/** A Worker's own vault in `env`, read off its `wrangler.jsonc`. */
export async function ownedVaultIn(workerDir: string, owner: string, env: string): Promise<OwnedVault | undefined> {
  const config = (await readOptionalWranglerConfig(workerDir).catch(() => null)) as {
    env?: Record<string, D1Stanza | undefined>;
  } | null;
  return ownedVaultOf(owner, config?.env?.[env]);
}

/** {@link ownedVaultIn}, refusing a Worker whose stanza names no vault yet: its manager would have no database. */
export async function requireOwnedVault(workerDir: string, owner: string, env: string): Promise<OwnedVault> {
  const vault = await ownedVaultIn(workerDir, owner, env);
  if (vault === undefined) {
    throw new ValidationError({
      message: `${env} has no SECRETS database for ${owner}, which owns its vault.`,
      action: provisionRemedy(env).say((command) => `Run ${command}, then provision secrets again.`),
    });
  }
  return vault;
}

/**
 * Every owned vault in `env`, for the shared manager: the Workers that compose `secrets` and own `SECRETS`, each
 * sealed under this environment's master key. A Worker whose stanza gives no id has no vault to re-seal yet.
 */
export async function projectOwnedVaults(
  workers: readonly Pick<ResolvedWorker, "capabilities" | "target" | "dir">[],
  env: string,
): Promise<OwnedVault[]> {
  const vaults: OwnedVault[] = [];
  for (const worker of workers) {
    const owner = secretsOwnerOf(worker);
    if (owner === undefined) continue;
    const vault = await ownedVaultIn(worker.dir, owner, env);
    if (vault) vaults.push(vault);
  }
  return vaults;
}
