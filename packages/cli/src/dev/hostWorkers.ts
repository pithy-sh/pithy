// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { envStem } from "@pithy-sh/core/src/env/stem";
import { messageOf, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { OWNED_BINDING_SEPARATOR } from "@pithy-sh/core/src/naming/limits";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { composeCapabilities } from "../capabilities/compose";
import { hostEntrySource } from "../capabilities/hostEntry";
import { hostEntryFile } from "../capabilities/hostFiles";
import {
  HOST_WORKERS,
  type HostDeliveryIdentity,
  type HostOwner,
  type HostWorkerSpec,
  hostOwnerFor,
  hostTemplatePath,
  hostWorkerFor,
  readHostTemplate as readHostTemplateDefault,
} from "../capabilities/hostRegistry";
import { writeFileAtomic } from "../project/atomic";
import { composeFor } from "../project/composeFor";
import { allCapabilities } from "../project/config";
import { DEFAULT_READY_SIGNAL } from "../project/workerManifest";
import type { WorkerTarget } from "../project/workers";
import { readOptionalWranglerConfig } from "../project/wrangler";

/**
 * **The dev set is app Workers plus the host Worker of every capability they compose.**
 *
 * `apps/` is the app-Worker registry and stays exactly that. Beside it, each composed capability that
 * owns Workflows contributes the prebuilt host Worker `pithy <capability> provision` would deploy —
 * resolved through the same seam the provisioners use ({@link HOST_WORKERS}), materialized into a
 * git-ignored directory, and handed to the orchestrator as an ordinary {@link WorkerTarget}. From
 * there it is not a special case: it gets a pinned port out of `.dev.config.json`, a label and a
 * color, an entry in `.dev-state.json`, and it is reaped with everything else.
 *
 * ## The name is the wire
 *
 * A host is registered under its **capability name** — `email`, not `acme-dev-email` — and each worker is handed
 * the `<CAPABILITY>_ORIGIN` of the hosts it reaches ({@link hostPortsFor}). That is the address core's loopback
 * dispatcher posts a Workflow dispatch to. A Worker that owns a binding a host binds gets a host of its own,
 * registered as `<owner>---<capability>`, and its `EMAIL_ORIGIN` names that one. An `apps/` Worker already holding a
 * host's name is refused rather than shadowed — the wire would be silently wrong.
 *
 * ## Where the config lands, and why it is generated at all
 *
 * Under `<project>/.wrangler/pithy/hosts/<name>/`, following `provision/featureConfig.ts`: every
 * scaffolded project ignores `.wrangler/` at any depth, so a generated
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
 * Database ids are the third: {@link HostResolveContext.databaseId} answers the binding name, because local D1
 * identity is `database_id ?? binding` — wrangler's chain, and the one `pithy migrate --env dev` keys the Miniflare
 * store by. An owned binding answers the id its owner's top-level stanza gives it, for the same reason. A host
 * resolved with anything else opens an empty database and fails `no such table` on its first query.
 */

/** Where a materialized host config lives, under the already-ignored `.wrangler/`. */
export function hostWorkerDir(projectDir: string, name: string): string {
  return join(projectDir, ".wrangler", "pithy", "hosts", name);
}

/** One discovered host: the dev-set member, the capability it belongs to, and how to resolve it. */
export interface HostWorker {
  /** The capability that owns the host — its dev-set name and the key into the registry. */
  capability: string;
  /** The dev-set member handed to the orchestrator. Ordinary in every respect. */
  worker: WorkerTarget;
  /** The registry entry that fills this host's template. */
  spec: HostWorkerSpec;
  /**
   * The composed capability object this host belongs to. Always present: a host is in the set only
   * because a Worker composed its capability. Required, as {@link HostResolveContext.capability} is, so no reader
   * can treat an absence as "use schema defaults" and ship defaults over an adopter's configuration.
   */
  composed: Capability;
  /**
   * Every *other* capability this host's composition reaches, for the resolutions that read across them — testers'
   * host takes its sending identity from the email capability's config, and the secrets manager aggregates every
   * registry. A shared host reads the Workers that share it; a Worker's own host reads that Worker's composition.
   */
  siblings: readonly Capability[];
  /**
   * Run every compose hook over this host's own set, so a capability object that also sits in another host's set
   * reports what this host reads. Called just before the host resolves.
   */
  assemble?: () => void;
  /**
   * The app Worker whose composition brought this host into the set — the directory its `.dev.vars`
   * is generated into, and therefore the one this host copies. A host reads the same secrets the
   * Worker that composes it does (the master key above all), and it has no `pithy.config.ts` of its
   * own for the generator to resolve targets from.
   */
  sourceDir: string;
  /**
   * The Worker this host is the own host of, when it owns a binding the host binds. Its dev-set name is then
   * `<owner>---<capability>`, it is built from that Worker's composition, and that Worker's `<CAPABILITY>_ORIGIN`
   * names it. Absent for the host every other Worker shares.
   */
  owner?: HostOwner;
}

/** A Worker's own host's dev-set name: `<owner>---<capability>`, the shape an owned resource's thing takes. */
export function ownedHostName(owner: string, capability: string): string {
  return `${owner}${OWNED_BINDING_SEPARATOR}${capability}`;
}

/** The composed capability one host is built from, the Worker it came from, and whose own host it is. */
interface HostSource {
  capability: Capability;
  dir: string;
  owner?: HostOwner;
}

/** What discovery found, and anything it had to survive on the way. */
export interface HostWorkerDiscovery {
  hosts: HostWorker[];
  /**
   * What discovery had to survive, one line at a time. A Worker whose config will not load is one;
   * silence would not be.
   *
   * **A note always means something is broken**, which is what lets a second caller act on it: `pithy
   * dev` prints them and runs the hosts it did find, and `pithy deploy --kit` fails the command,
   * because a note means an app Worker's capabilities are invisible and their Workers would silently
   * not ship. A Worker with no `pithy.config.ts` and no `wrangler.jsonc` is therefore not noted at all.
   */
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

/**
 * Whether a failure to read a Worker's capabilities is "there is no `pithy.config.ts` here" — the one
 * shape that can be an ordinary state rather than a fault.
 *
 * `loadWorkerConfig` throws `core/not_found` for exactly that and `core/internal` for a config that is
 * present and will not import, which is what keeps the two apart without matching on a sentence.
 */
function isMissingConfig(error: unknown): boolean {
  return error instanceof PithyError && error.payload.code === "core/not_found";
}

/**
 * The dev block a host Worker runs under. A ready signal and nothing else.
 *
 * There is no autostart key: every worker starts, and the only thing that stops one is this branch's own answer in
 * `dev-ports.json`. A host is reachable by that answer like anything else — it is keyed on its dev-set name, which
 * is the name `--app` takes and the name every listing prints — and turning off `email` locally is an explicit act
 * by somebody who knows its Workflows will not run.
 */
function hostDev(): WorkerTarget["dev"] {
  return { readySignal: DEFAULT_READY_SIGNAL };
}

/**
 * Every host Worker the project's app Workers compose, in registry order.
 *
 * A Worker whose `pithy.config.ts` will not load contributes nothing and is named — the same trade
 * the entitlement check makes. `pithy dev` reports wiring; a config that will not import is
 * wrangler's error to raise, and refusing to run the whole session over it would be a worse trade.
 * A Worker that has no `pithy.config.ts` at all and no `wrangler.jsonc` either is a dev-only process
 * rather than an unreadable Worker: it composes nothing, and nothing is said about it.
 */
export async function discoverHostWorkers(options: DiscoverHostWorkersOptions): Promise<HostWorkerDiscovery> {
  const capabilitiesFor =
    options.capabilitiesFor ??
    ((dir: string) => composeFor(LOCAL_ENVIRONMENT, async (load) => allCapabilities(await load(dir))));

  const notes: string[] = [];
  const composed = new Map<string, { capability: Capability; dir: string }>();
  // Every Worker's composition, in discovery order: a Worker that owns what a host binds gets its own host.
  const compositions: { worker: WorkerTarget; capabilities: Capability[] }[] = [];
  for (const worker of options.workers) {
    let capabilities: Capability[];
    try {
      capabilities = await capabilitiesFor(worker.dir);
    } catch (error) {
      // **A dev-only process is not a gap.** A Vite frontend joins the set through `pithy.worker.jsonc`
      // alone: it has no `pithy.config.ts`, never had one, and composes nothing — so there is nothing to
      // say about it. A directory carrying a `wrangler.jsonc` *is* a Worker, so an absent config there
      // leaves the set incomplete and is noted like any other unreadable one. `project/workerScope.ts`
      // partitions the same two cases on the same strict `hasWrangler === true`, for the same reason:
      // real discovery always sets the flag, and the test doubles that carry only `name`/`dir`
      // must not start reporting themselves as gaps.
      //
      // It matters beyond a line of output: `pithy deploy --kit` fails the command on any note
      // (`project/deployKit.ts`), and a project with a front end must not fail a deploy for having one.
      if (isMissingConfig(error) && worker.hasWrangler !== true) continue;
      notes.push(`${worker.name}: its capabilities could not be read, so its capability hosts will not run.`);
      notes.push(`  ${messageOf(error)}`);
      continue;
    }
    compositions.push({ worker, capabilities });
    // The first declaration by a Worker that shares the host's bindings wins. Two such Workers share one host,
    // exactly as they share a D1 by declaring one binding name; a Worker owning one of them gets its own below.
    for (const capability of capabilities) {
      if (composed.has(capability.name)) continue;
      const spec = hostWorkerFor(capability.name);
      if (spec && hostOwnerFor(spec, capability, worker)) continue;
      composed.set(capability.name, { capability, dir: worker.dir });
    }
  }
  // Each Worker's own hosts, built from that Worker's composition.
  const owned = new Map<string, HostSource[]>();
  for (const { worker, capabilities } of compositions) {
    for (const capability of capabilities) {
      const spec = hostWorkerFor(capability.name);
      const owner = spec && hostOwnerFor(spec, capability, worker);
      if (!owner) continue;
      owned.set(capability.name, [...(owned.get(capability.name) ?? []), { capability, dir: worker.dir, owner }]);
    }
  }
  // **A shared host reads across the Workers that share it**: every Worker's composition but those that own this
  // capability's host, the first declaration of each capability winning. An owner's i18n or registry reaches its own
  // host, never the shared one it does not read from.
  const sharedSets = new Map<string, Capability[]>();
  for (const spec of HOST_WORKERS) {
    const source = composed.get(spec.capability);
    if (!source) continue;
    const set = new Map<string, Capability>([[source.capability.name, source.capability]]);
    for (const { worker, capabilities } of compositions) {
      const own = capabilities.find((capability) => capability.name === spec.capability);
      if (own && hostOwnerFor(spec, own, worker)) continue;
      for (const capability of capabilities) if (!set.has(capability.name)) set.set(capability.name, capability);
    }
    sharedSets.set(spec.capability, [...set.values()]);
  }

  // **Assembled before a single host reads one of them.** A capability object is a placeholder for
  // half of what it reports until its `compose` hook has run, and the email host's resolver reads
  // exactly such a value: `hostCatalogs()` answers `{}` on an unassembled capability, which would materialize
  // an English-only host for a project that speaks two languages — and `runSend` overwrites the stored subject
  // with its own render. See `capabilities/compose.ts`, and `emailProvisioner.ts` for the deployed half. One object
  // can sit in more than one host's set, so each host is assembled again from its own set just before it resolves.
  //
  // **Degraded, not fatal, for the same reason the read above is.** A compose hook throws — `auth`
  // refuses a plugin claiming a kit table, `payments` checks its ledger grants — and a shared host's set is a
  // union across Workers rather than any one Worker's own. So a pair of Workers can
  // collide here on something neither of them would refuse at its own boot, and an uncaught throw would
  // end the whole `pithy dev` session rather than the one host it concerns. A session that starts
  // without the email host and says why is worth more than one that does not start.
  try {
    for (const set of sharedSets.values()) composeCapabilities(set);
  } catch (error) {
    notes.push("The capability hosts could not be assembled, so none of them will run.");
    notes.push(`  ${messageOf(error)}`);
    return { hosts: [], notes };
  }
  // A Worker's own host reads that Worker's capability objects, so they are assembled as that Worker assembles them.
  const ownSets = new Map<string, Capability[]>();
  const owners = new Set([...owned.values()].flat().map((entry) => entry.dir));
  for (const { worker, capabilities } of compositions) {
    if (!owners.has(worker.dir)) continue;
    try {
      composeCapabilities(capabilities);
      ownSets.set(worker.dir, capabilities);
    } catch (error) {
      notes.push(`${worker.name}: its capabilities could not be assembled, so its own capability hosts will not run.`);
      notes.push(`  ${messageOf(error)}`);
      for (const [name, entries] of owned) {
        owned.set(
          name,
          entries.filter((entry) => entry.dir !== worker.dir),
        );
      }
    }
  }

  const taken = new Set(options.workers.map((worker) => worker.name));
  const hosts: HostWorker[] = [];
  const add = (spec: HostWorkerSpec, source: HostSource, set: Capability[]): void => {
    const name = source.owner ? ownedHostName(source.owner.worker, spec.capability) : spec.capability;
    if (taken.has(name)) {
      throw new ValidationError({
        message: `A Worker in apps/ is named "${name}", which is also the ${spec.capability} capability's host.`,
        action: `Rename that Worker with ${commandName("worker rename")}, or move it, so ${spec.capability.toUpperCase()}_ORIGIN names one process.`,
        detail: "Sibling addresses are keyed by worker name; two workers sharing one would publish one address.",
      });
    }
    hosts.push({
      capability: spec.capability,
      spec,
      composed: source.capability,
      siblings: set.filter((one) => one.name !== spec.capability),
      sourceDir: source.dir,
      ...(source.owner ? { owner: source.owner } : {}),
      assemble: () => void composeCapabilities(set),
      worker: { name, dir: hostWorkerDir(options.projectDir, name), hasWrangler: true, dev: hostDev() },
    });
  };
  for (const spec of HOST_WORKERS) {
    const shared = composed.get(spec.capability);
    const set = sharedSets.get(spec.capability);
    if (shared && set) add(spec, shared, set);
    for (const entry of owned.get(spec.capability) ?? [])
      add(spec, entry, ownSets.get(entry.dir) ?? [entry.capability]);
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
  /** The origin one host's links are built against instead of {@link baseUrl} — a Worker's own host, its owner's. */
  baseUrlFor?: (host: HostWorker) => string | undefined;
  hosts: readonly HostWorker[];
  /** No message may leave this machine — the delivery preflight's verdict, passed to every resolver. */
  simulateDelivery?: boolean;
  /** Seam: read a capability's committed template. Defaults to the file beside its worker entry. */
  readTemplate?: (projectDir: string, entry: string) => Promise<WorkflowHostTemplate>;
}

/**
 * What materialization produced: the lines to say, and the hosts that have no config on disk.
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
  /** The dev-set names of the hosts that have no config, and which therefore must not be started. */
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
      host.assemble?.();
      const template = await readTemplate(options.projectDir, host.spec.entry);
      const ownIds = host.owner ? await localDatabaseIds(host.sourceDir, host.owner.bindings) : {};
      const resolved = await host.spec.resolve(template, {
        projectDir: options.projectDir,
        project: options.project,
        env: LOCAL_ENVIRONMENT,
        baseUrl: options.baseUrlFor?.(host) ?? options.baseUrl,
        // An owned binding's local store is keyed on the id its owner's top-level stanza gives it; every other
        // binding's on the binding itself.
        databaseId: (binding) => ownIds[binding] ?? binding,
        ...(host.owner ? { owner: host.owner } : {}),
        // **Dev's defaults, stated here rather than defaulted in the registry.** There is no Secrets
        // Store on a developer's machine — the master key arrives in `.dev.vars`, and `forLocalDev`
        // drops the `secrets_store_secrets` block below before this config reaches disk — so the empty
        // string is the honest answer and not an absent one. Here rather than in the registry, so
        // `pithy deploy --kit` never inherits it.
        storeId: () => "",
        // Only the secrets manager stamps this, and locally it manages nothing: its own dev run reads
        // the account from `.dev.vars` like every other Worker.
        accountId: () => "",
        capability: host.composed,
        siblings: host.siblings,
        simulateDelivery: options.simulateDelivery,
      });
      const config = forLocalDev(resolved, options.projectDir, host.spec.entry);
      const path = join(host.worker.dir, "wrangler.jsonc");
      await mkdir(dirname(path), { recursive: true });
      // The peers the project composes, handed to a host that composes nothing — the same generated entry a
      // deploy ships, so a local pass credits and reads exactly what a deployed one does.
      const entry = hostEntrySource(options.projectDir, host.spec, host.composed, host.siblings);
      if (entry !== undefined) {
        const entryPath = join(host.worker.dir, hostEntryFile(LOCAL_ENVIRONMENT));
        await writeFileAtomic(entryPath, entry);
        config.main = entryPath;
      }
      await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
    } catch (error) {
      notes.push(`${host.worker.name}: its host worker could not be resolved, so it will not run.`);
      notes.push(`  ${messageOf(error)}`);
      failed.push(host.worker.name);
    }
  }

  return { notes, failed };
}

/**
 * The local `database_id` an owning Worker's top-level stanza gives each of `bindings`, where it gives one. That id
 * keys the owned database's own Miniflare store, which `pithy migrate --env dev` filled.
 */
async function localDatabaseIds(workerDir: string, bindings: readonly string[]): Promise<Record<string, string>> {
  const config = (await readOptionalWranglerConfig(workerDir).catch(() => null)) as {
    d1_databases?: { binding?: string; database_id?: string }[];
  } | null;
  const ids: Record<string, string> = {};
  for (const entry of config?.d1_databases ?? []) {
    if (entry.binding && entry.database_id && bindings.includes(entry.binding)) ids[entry.binding] = entry.database_id;
  }
  return ids;
}

/** The two edits that are true of every host locally, applied after the capability's own resolver. */
function forLocalDev(resolved: WorkflowHostTemplate, projectDir: string, entry: string): WorkflowHostTemplate {
  const config: WorkflowHostTemplate = { ...resolved };
  if (!isAbsolute(config.main)) config.main = join(dirname(hostTemplatePath(projectDir, entry)), config.main);
  config.secrets_store_secrets = undefined;
  return config;
}

/**
 * The host addresses one Worker is handed, keyed by **capability** — the name its `<CAPABILITY>_ORIGIN` is derived
 * from. The shared hosts, with the Worker's own hosts in their place where it has one; another Worker's own hosts
 * never. `workerDir` is the app Worker's directory, or an owned host's owner's; `undefined` reaches the shared hosts
 * alone. A host with no pinned port in `ports` is left out, so nothing publishes an address nobody answers on.
 */
export function hostPortsFor(
  hosts: readonly HostWorker[],
  ports: Readonly<Record<string, number>>,
  workerDir: string | undefined,
): Record<string, number> {
  const reached: Record<string, number> = {};
  for (const host of hosts) {
    if (host.owner) continue;
    const port = ports[host.worker.name];
    if (port !== undefined) reached[host.capability] = port;
  }
  for (const host of hosts) {
    if (!host.owner || workerDir === undefined || host.sourceDir !== workerDir) continue;
    const port = ports[host.worker.name];
    if (port === undefined) delete reached[host.capability];
    else reached[host.capability] = port;
  }
  return reached;
}

/**
 * **The hosts one dev-set member reaches, by capability, and their ports.** An app Worker reaches the shared hosts,
 * or its own in their place. A host reaches what the Worker it was built from reaches — the shared hosts for a
 * shared one, its owner's for a Worker's own — and never its own capability, or its dispatches would loop back to
 * it rather than start its Workflow.
 */
export function hostsReachedBy(
  hosts: readonly HostWorker[],
  ports: Readonly<Record<string, number>>,
  member: { name: string; dir: string },
): Record<string, number> {
  const host = hosts.find((candidate) => candidate.worker.name === member.name);
  if (host === undefined) return hostPortsFor(hosts, ports, member.dir);
  const reach = hostPortsFor(hosts, ports, host.owner ? host.sourceDir : undefined);
  delete reach[host.capability];
  return reach;
}

/**
 * {@link hostPortsFor}'s answer as the environment a custom `dev.command` inherits, which has no `--var` to carry it:
 * the `<STEM>_ORIGIN` and `<STEM>_PORT` pair `wrangler dev` is handed for each host.
 */
export function hostOriginEnv(reach: Readonly<Record<string, number>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, port] of Object.entries(reach)) {
    const stem = envStem(name);
    env[`${stem}_ORIGIN`] = `http://localhost:${port}`;
    env[`${stem}_PORT`] = String(port);
  }
  return env;
}

/** Whether a capability owns a host Worker at all — the question `pithy doctor` and `migrate` both ask. */
export function capabilityHostsWorkflows(capability: string): boolean {
  return hostWorkerFor(capability) !== undefined;
}

/**
 * What each host would put on the wire from the developer's machine, asked of every host rather than of the one
 * capability that answers, and of each host's own composition: a Worker's own email host sends from that Worker's
 * address, in the delivery mode that Worker chose. `pithy dev`'s delivery preflight reads this, so the dev command
 * branches on no capability — a tenth host that sends something implements `delivery` and is preflighted with no
 * change here or there.
 *
 * A host whose package will not load answers nothing rather than failing the session: the
 * materialization that follows names that same failure, and once is enough.
 */
export async function hostDeliveryIdentities(
  projectDir: string,
  hosts: readonly HostWorker[],
): Promise<{ host: HostWorker; identity: HostDeliveryIdentity }[]> {
  const identities: { host: HostWorker; identity: HostDeliveryIdentity }[] = [];
  for (const host of hosts) {
    try {
      const identity = await host.spec.delivery?.(host.composed, projectDir);
      if (identity) identities.push({ host, identity });
    } catch {
      // Named by materializeHostConfigs, which reaches the same package on the same run.
    }
  }
  return identities;
}
