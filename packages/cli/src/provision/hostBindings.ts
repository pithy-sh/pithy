// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { OwnedHostedWorkflowEntry } from "../feature/hosts";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";

/**
 * **Where a declared environment's Workflow bindings into the kit hosts point.** Each Worker's `workflows` entry for
 * a capability host's job names the host it reaches: the shared one, or the Worker's own where it owns a binding that
 * host binds. `pithy provision --env` writes them, so a Worker that took a binding into `ownBindings` is moved onto
 * its own host by the same run that creates its own database.
 */

/** One kit host the provisioned Workers' bindings reach, and which of them reach it. */
export interface ProvisionedHost {
  /** The capability that owns the host. */
  capability: string;
  /** The `apps/<owner>` Worker this is the own host of, when it is one. */
  owner?: string;
  /** The host's script name in this environment. */
  script: string;
  /** The Workers whose stanza binds into it, by deploy name. */
  workers: string[];
}

/**
 * Point `env.<env>.workflows` of the Worker in `workerDir` at the hosts `entries` name: each entry replaces the one
 * for its binding, or is added. Entries for other bindings are left as they are. Writes nothing when nothing changes,
 * and answers whether it wrote.
 */
export async function bindHostWorkflows(
  workerDir: string,
  env: string,
  entries: readonly OwnedHostedWorkflowEntry[],
): Promise<boolean> {
  if (entries.length === 0) return false;
  const config = (await readWranglerConfig(workerDir)) as {
    env?: Record<string, { workflows?: Record<string, unknown>[] } | undefined>;
  };
  const stanza = config.env?.[env];
  if (stanza === undefined) return false;
  stanza.workflows ??= [];
  const workflows = stanza.workflows;
  let changed = false;
  for (const { binding, name, class_name, script_name } of entries) {
    const next = { binding, name, class_name, script_name };
    const at = workflows.findIndex((entry) => entry.binding === binding);
    const current = at === -1 ? undefined : workflows[at];
    if (current && current.name === name && current.class_name === class_name && current.script_name === script_name)
      continue;
    // In place, so comment-json keeps the entry's comments.
    if (current) Object.assign(current, next);
    else workflows.push(next);
    changed = true;
  }
  if (changed) await writeWranglerConfig(workerDir, config);
  return changed;
}

/** Fold one Worker's entries into the hosts its stanza reaches, keyed by script. */
export function addProvisionedHosts(
  hosts: Map<string, ProvisionedHost>,
  worker: string,
  entries: readonly OwnedHostedWorkflowEntry[],
): void {
  for (const entry of entries) {
    const host = hosts.get(entry.script_name) ?? {
      capability: entry.capability,
      ...(entry.owner ? { owner: entry.owner } : {}),
      script: entry.script_name,
      workers: [],
    };
    if (!host.workers.includes(worker)) host.workers.push(worker);
    hosts.set(entry.script_name, host);
  }
}
