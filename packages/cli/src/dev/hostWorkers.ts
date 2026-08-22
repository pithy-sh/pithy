// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import {
  HOST_WORKERS,
  type HostDeliveryIdentity,
  type HostWorkerSpec,
  hostTemplatePath,
  hostWorkerFor,
  readHostTemplate as readHostTemplateDefault,
} from "../capabilities/hostRegistry";
import { writeFileAtomic } from "../project/atomic";
import { allCapabilities, loadWorkerConfig } from "../project/config";
import { DEFAULT_READY_SIGNAL } from "../project/workerManifest";
import type { WorkerTarget } from "../project/workers";

/**
 * **The dev set is app Workers plus the host Worker of every capability they compose.**
 *
 * `apps/` is the app-Worker registry and stays exactly that. Beside it, each composed capability that
 * owns Workflows contributes the prebuilt host Worker `pithy <capability> provision` would deploy —
 * resolved through the same seam the provisioners use ({@link HOST_WORKERS}), materialised into a
 * git-ignored directory, and handed to the orchestrator as an ordinary {@link WorkerTarget}. From
 * there it is not a special case: it gets a pinned port out of `.dev.config.json`, a label and a
 * color, an entry in `.dev-state.json`, and it is reaped with everything else.
 *
 * ## The name is the wire
 *
 * A host is registered under its **capability name** — `email`, not `acme-dev-email`. `buildWorkerEnv`
 * derives `<STEM>_ORIGIN` from whatever name a worker carries in the dev config, so `email` is what
 * makes an app Worker's `EMAIL_ORIGIN` resolve, and that is the address core's loopback dispatcher
 * posts a Workflow dispatch to. A host named after its deployed script would publish
 * `ACME_DEV_EMAIL_ORIGIN`, which nothing looks up. An `apps/` Worker already holding that name is
 * therefore refused rather than shadowed — the wire would be silently wrong, which is the whole
 * failure this issue is about.
 *
 * ## Where the config lands, and why it is generated at all
 *
 * Under `<project>/.wrangler/pithy/hosts/<capability>/`, following `provision/featureConfig.ts`: every
 * scaffolded project has ignored `.wrangler/` at any depth since the first release, so a generated
 * config can never be committed and `git add -A` cannot reach it. It is generated rather than shipped
 * because a host template is a *template* — its database ids, its base URL and its theme are the
 * adopter's, and only a resolution knows them.
 *
 * Two dev-shaped edits happen after the capability's own resolver has run, and both are here rather
 * than in the resolvers because both are true of every host at once:
 *
 * - **`main` becomes absolute.** wrangler resolves `main` relative to the config file, and this config
 *   sits nowhere near the entry it names — the entry is inside `node_modules`.
 * - **`secrets_store_secrets` is dropped.** There is no Secrets Store locally; the master key reaches
 *   a local Worker as a `.dev.vars` value, exactly as it reaches the app Worker.
 *
 * Database ids are the third, and are the registry's own job: {@link HostResolveContext.databaseId}
 * answers the binding name, because local D1 identity is `database_id ?? binding` — wrangler's chain,
 * and the one `pithy migrate --env dev` keyed the Miniflare store by. A host resolved with anything
 * else opens an empty database and fails `no such table` on its first query.
 */

/** Where a materialised host config lives, under the already-ignored `.wrangler/`. */
export function hostWorkerDir(projectDir: string, capability: string): string {
  return join(projectDir, ".wrangler", "pithy", "hosts", capability);
}

/** One discovered host: the dev-set member, the capability it belongs to, and how to resolve it. */
export interface HostWorker {
  /** The capability that owns the host — its dev-set name and the key into the registry. */
  capability: string;
  /** The dev-set member handed to the orchestrator. Ordinary in every respect. */
  worker: WorkerTarget;
  /** The registry entry that fills this host's template. */
  spec: HostWorkerSpec;
  /** The composed capability object, when a Worker's config carried one this resolver can read. */
  composed?: Capability;
  /**
   * The app Worker whose composition brought this host into the set — the directory its `.dev.vars`
   * is generated into, and therefore the one this host copies. A host reads the same secrets the
   * Worker that composes it does (the master key above all), and it has no `pithy.config.ts` of its
   * own for the generator to resolve targets from.
   */
  sourceDir: string;
}

/** What discovery found, and anything it had to survive on the way. */
export interface HostWorkerDiscovery {
  hosts: HostWorker[];
  /** Non-fatal lines for the terminal. A Worker whose config will not load is one; silence would not be. */
  notes: string[];
}

/** Options for {@link discoverHostWorkers}. */
export interface DiscoverHostWorkersOptions {
  projectDir: string;
  /** Every discovered app Worker. Their composed capabilities decide the host set. */
  workers: readonly WorkerTarget[];
  /** Seam: the capabilities one Worker composes. Defaults to loading its `apps/<name>/pithy.config.ts`. */
  capabilitiesFor?: (workerDir: string) => Promise<Capability[]>;
}

/** The dev block a host Worker runs under: it must be up for the local loop to work, so it autostarts. */
function hostDev(): WorkerTarget["dev"] {
  return { autostart: true, readySignal: DEFAULT_READY_SIGNAL };
}

/**
 * Every host Worker the project's app Workers compose, in registry order.
 *
 * A Worker whose `pithy.config.ts` will not load contributes nothing and is named — the same trade
 * the entitlement check makes. `pithy dev` reports wiring; a config that will not import is
 * wrangler's error to raise, and refusing to run the whole session over it would be a worse trade.
 */
export async function discoverHostWorkers(options: DiscoverHostWorkersOptions): Promise<HostWorkerDiscovery> {
  const capabilitiesFor =
    options.capabilitiesFor ?? (async (dir: string) => allCapabilities(await loadWorkerConfig(dir)));

  const notes: string[] = [];
  const composed = new Map<string, { capability: Capability; dir: string }>();
  for (const worker of options.workers) {
    let capabilities: Capability[];
    try {
      capabilities = await capabilitiesFor(worker.dir);
    } catch (error) {
      notes.push(`${worker.name}: its capabilities could not be read, so its capability hosts will not run.`);
      notes.push(`  ${messageOf(error)}`);
      continue;
    }
    // First declaration wins. Two Workers composing one capability share one host, exactly as they
    // share a D1 by declaring one binding name — the host is the capability's, not the Worker's.
    for (const capability of capabilities) {
      if (!composed.has(capability.name)) composed.set(capability.name, { capability, dir: worker.dir });
    }
  }

  const taken = new Set(options.workers.map((worker) => worker.name));
  const hosts: HostWorker[] = [];
  for (const spec of HOST_WORKERS) {
    const owner = composed.get(spec.capability);
    if (!owner) continue;
    if (taken.has(spec.capability)) {
      throw new ValidationError({
        message: `A Worker in apps/ is named "${spec.capability}", which is also the ${spec.capability} capability's host.`,
        action: `Rename that Worker with pithy worker add, or move it, so ${spec.capability.toUpperCase()}_ORIGIN names one process.`,
        detail: "Sibling addresses are keyed by worker name; two workers sharing one would publish one address.",
      });
    }
    hosts.push({
      capability: spec.capability,
      spec,
      composed: owner.capability,
      sourceDir: owner.dir,
      worker: {
        name: spec.capability,
        dir: hostWorkerDir(options.projectDir, spec.capability),
        hasWrangler: true,
        dev: hostDev(),
      },
    });
  }

  return { hosts, notes };
}

/** Options for {@link materializeHostConfigs}. */
export interface MaterializeHostConfigsOptions {
  projectDir: string;
  /** The project name — the leading segment of every name a resolution derives. Never guessed. */
  project: string;
  /** The app Worker's local origin, which callback links in a locally sent message are built against. */
  baseUrl: string;
  hosts: readonly HostWorker[];
  /** No message may leave this machine — the delivery preflight's verdict, passed to every resolver. */
  simulateDelivery?: boolean;
  /** Seam: read a capability's committed template. Defaults to the file beside its worker entry. */
  readTemplate?: (entry: string) => Promise<WorkflowHostTemplate>;
}

/**
 * What materialisation produced: the lines to say, and the hosts that have no config on disk.
 *
 * The second list is not decoration. A host whose resolution threw has no directory — `mkdir` runs on
 * the write path and never got there — so spawning `wrangler dev` in it fails with ENOENT, the
 * orchestrator's spawn-error handler tears the whole session down, and every Worker that was running
 * fine dies for one capability nobody could resolve. The note already said "it will not run"; this is
 * what makes that sentence true.
 */
export interface HostMaterialization {
  /** Non-fatal lines for the terminal, in the order they happened. */
  notes: string[];
  /** The capability names whose host has no config, and which therefore must not be started. */
  failed: string[];
}

/**
 * Resolve and write each host's local `wrangler.jsonc`. Returns non-fatal notes and the hosts that got
 * none: a capability whose package will not load is named and dropped, because one unresolvable host is
 * not a reason to refuse to run the Workers that are fine — nor to start one in a directory that is
 * not there.
 */
export async function materializeHostConfigs(options: MaterializeHostConfigsOptions): Promise<HostMaterialization> {
  const readTemplate = options.readTemplate ?? readHostTemplateDefault;
  const notes: string[] = [];
  const failed: string[] = [];

  for (const host of options.hosts) {
    try {
      const template = await readTemplate(host.spec.entry);
      const resolved = await host.spec.resolve(template, {
        project: options.project,
        env: LOCAL_ENVIRONMENT,
        baseUrl: options.baseUrl,
        databaseId: (binding) => binding,
        capability: host.composed,
        simulateDelivery: options.simulateDelivery,
      });
      const config = forLocalDev(resolved, host.spec.entry);
      const path = join(host.worker.dir, "wrangler.jsonc");
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
    } catch (error) {
      notes.push(`${host.capability}: its host worker could not be resolved, so it will not run.`);
      notes.push(`  ${messageOf(error)}`);
      failed.push(host.capability);
    }
  }

  return { notes, failed };
}

/** The two edits that are true of every host locally, applied after the capability's own resolver. */
function forLocalDev(resolved: WorkflowHostTemplate, entry: string): WorkflowHostTemplate {
  const config: WorkflowHostTemplate = { ...resolved };
  if (!isAbsolute(config.main)) config.main = join(dirname(hostTemplatePath(entry)), config.main);
  config.secrets_store_secrets = undefined;
  return config;
}

/** Whether a capability owns a host Worker at all — the question `pithy doctor` and `migrate` both ask. */
export function capabilityHostsWorkflows(capability: string): boolean {
  return hostWorkerFor(capability) !== undefined;
}

/**
 * What this project would put on the wire from the developer's machine, asked of every host rather
 * than of the one capability that answers. `pithy dev`'s delivery preflight reads this, so the dev
 * command branches on no capability — a tenth host that sends something implements `delivery` and is
 * preflighted with no change here or there.
 *
 * A host whose package will not load answers nothing rather than failing the session: the
 * materialisation that follows names that same failure, and once is enough.
 */
export async function hostDeliveryIdentity(hosts: readonly HostWorker[]): Promise<HostDeliveryIdentity | undefined> {
  for (const host of hosts) {
    try {
      const identity = await host.spec.delivery?.(host.composed);
      if (identity) return identity;
    } catch {
      // Named by materializeHostConfigs, which reaches the same package on the same run.
    }
  }
  return undefined;
}
