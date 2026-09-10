// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { loadProject, requireProjectName } from "../project/config";
import { defaultWorkerDev } from "../project/workerManifest";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "../project/workers";
import { dim } from "../terminal/style";
import {
  discoverHostWorkers as discoverHostWorkersDefault,
  type HostWorker,
  type HostWorkerDiscovery,
} from "./hostWorkers";

/**
 * **The dev set, decided in one place.**
 *
 * A `pithy dev` run and a `pithy dev --list` have to agree about what the set *is* — which Workers are in
 * it, which are capability hosts, and which of them a plain run would start. Computed twice, they would
 * drift, and the listing would be a description of a run nobody makes. So both consume this, and neither
 * assembles a set of its own.
 *
 * The set is two sources. `apps/` is the app-Worker registry ({@link discoverWorkers}); beside it, every
 * capability those Workers compose that owns Workflows contributes a prebuilt host Worker, resolved from
 * the composition rather than from `apps/` ({@link discoverHostWorkers}). A project composing half of
 * them runs Workers it never added, which is why the second half of the set has to be nameable.
 *
 * **It writes nothing and spawns nothing.** Every read here is a read: discovery enumerates directories,
 * the project name is loaded, and host discovery only *computes* each host's directory. Materializing a
 * host's config, generating a `.dev.vars`, pinning a port, and spawning are all the caller's own steps.
 */

/** Which half of the set a member came from: the `apps/` registry, or a composed capability's host. */
export type DevMemberKind = "app" | "host";

/** One member of the dev set: the target, where it came from, and whether a plain run would start it. */
export interface DevSetMember {
  /** The dev-set member itself — an `apps/` Worker or a host, ordinary in every respect either way. */
  worker: WorkerTarget;
  /** `app` for an `apps/` Worker, `host` for a composed capability's host Worker. */
  kind: DevMemberKind;
  /** Whether a plain `pithy dev` starts it — the manifest's `dev.autostart`, which defaults to true. */
  autostart: boolean;
}

/** Everything {@link resolveDevSet} needs, every dependency defaulted to its real implementation. */
export interface DevSetOptions {
  /** The project root — the parent of `apps/`. */
  projectDir: string;
  /** Discovery seam (default: `discoverWorkers`). */
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
  /** Seam: the project name every host's derived names lead with. `null` skips the hosts, loudly. */
  projectName?: (projectDir: string) => Promise<string | null>;
  /** Seam: the host Worker of every capability the project's Workers compose. */
  discoverHostWorkers?: (options: {
    projectDir: string;
    workers: readonly WorkerTarget[];
  }) => Promise<HostWorkerDiscovery>;
}

/** The resolved dev set: its members, the hosts among them, and anything discovery had to survive. */
export interface DevSet {
  /** The project name, or `null` when the project states none — which is why there are no hosts. */
  project: string | null;
  /** Every member, `apps/` Workers in discovery order followed by the hosts in registry order. */
  members: DevSetMember[];
  /** The host entries behind the `host`-kind members — what materialization and delivery need. */
  hosts: HostWorker[];
  /** The host members' names, for the several places a host is not treated like an app Worker. */
  hostNames: Set<string>;
  /** Non-fatal lines for whoever is reading. A Worker whose config will not load is one; silence is not. */
  notes: readonly string[];
}

/**
 * The project name every host's derived names lead with, or `null` when the project states none.
 *
 * `requireProjectName` rather than `resolveProjectName`: a guessed name differs between checkouts,
 * and this one is stamped into a Worker script name. A project that states none gets no hosts and
 * one line saying why — the alternative is a host running under a name nothing else in the project
 * would reproduce.
 */
const defaultProjectName = async (projectDir: string): Promise<string | null> => {
  try {
    return requireProjectName(await loadProject(projectDir));
  } catch {
    return null;
  }
};

/**
 * The project's dev set: every `apps/` Worker, plus the host of every capability they compose.
 *
 * The project name is settled first, because it is stamped into each host's derived Worker script name.
 * A project that states none gets no hosts and two lines saying so.
 *
 * Throws only what its reads throw — most usefully `discoverHostWorkers`' refusal when an `apps/` Worker
 * is named after a capability host, which would publish one `<STEM>_ORIGIN` for two processes.
 */
export async function resolveDevSet(options: DevSetOptions): Promise<DevSet> {
  const discovered = await (options.discoverWorkers ?? discoverWorkersDefault)(options.projectDir);
  const project = await (options.projectName ?? defaultProjectName)(options.projectDir);
  const finding =
    project === null
      ? {
          hosts: [],
          notes: [
            "No project name in pithy.config.ts, so no capability host can be named — none will run.",
            dim('  set: export default { name: "<project>" }'),
          ],
        }
      : await (options.discoverHostWorkers ?? discoverHostWorkersDefault)({
          projectDir: options.projectDir,
          workers: discovered,
        });

  const member = (worker: WorkerTarget, kind: DevMemberKind): DevSetMember => ({
    worker,
    kind,
    autostart: (worker.dev ?? defaultWorkerDev()).autostart,
  });

  return {
    project,
    members: [...discovered.map((w) => member(w, "app")), ...finding.hosts.map((h) => member(h.worker, "host"))],
    hosts: finding.hosts,
    hostNames: new Set(finding.hosts.map((h) => h.worker.name)),
    notes: finding.notes,
  };
}

/**
 * The members `--app` names, in member order — or a refusal naming the valid set.
 *
 * **Three name forms, one predicate.** The deployed name (which for a host *is* its capability name, since
 * that is what the host is registered under and what its siblings reach it at), or the `apps/<dir>`
 * basename. `basename` rather than a `dir.endsWith("/" + name)` test: the directory was composed with
 * `join`, so on Windows the separator is not the one that comparison looks for.
 *
 * **All or nothing.** One unknown name refuses the whole selection, so nothing half-starts and then dies —
 * and it refuses here, above every write the caller goes on to make. Member order rather than flag order,
 * because labels, colors, host ports and `.dev-state.json`'s entries all key on the position a member holds.
 *
 * **The deployed name wins, and the directory is the fallback.** One string can mean two members:
 * `discoverHostWorkers` refuses an `apps/` Worker whose *deployed* name is a capability's, but a Worker in
 * `apps/email/` deployed as `acme-email` clears that guard, and then `email` is the host's name and that
 * Worker's directory at once. Matching both at once would start two processes for one name; refusing would
 * leave the host unnameable, since `email` is the only string it answers to. So the two forms are tried in
 * order, and the deployed name goes first because it is the key `.dev.config.json`, `.dev-state.json` and
 * `<STEM>_ORIGIN` are all written under. Only a tier that is itself ambiguous refuses — two Workers deployed
 * under one name, which is a project already broken, since both would share that one port entry.
 */
export function selectDevMembers(members: readonly DevSetMember[], names: readonly string[]): DevSetMember[] {
  const chosen = new Set<DevSetMember>();
  for (const name of names) {
    const byName = members.filter((candidate) => candidate.worker.name === name);
    const matched = byName.length > 0 ? byName : members.filter((c) => basename(c.worker.dir) === name);

    const only = matched[0];
    if (only === undefined) {
      const known = members.map((m) => m.worker.name).join(", ");
      throw new NotFoundError({
        message: `No worker named "${name}".`,
        // `pithy dev --list`, not `pithy worker list`: the registry view names no capability host, and a
        // host's capability name is one of the three forms this accepts.
        action: `Run pithy dev --list to see this project's dev set. Known: ${known || "none"}.`,
      });
    }
    if (matched.length > 1) {
      // Named by directory, never by name: the two share the name that is ambiguous, so repeating it
      // would offer a remedy that reproduces this refusal. The directories always tell them apart.
      throw new ValidationError({
        message: `"${name}" names two workers.`,
        action: `Rename one of them: ${matched.map((m) => m.worker.dir).join(", ")}.`,
      });
    }
    chosen.add(only);
  }
  // Member order, not flag order, and each member once however many of its spellings were named.
  return members.filter((candidate) => chosen.has(candidate));
}
