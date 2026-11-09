// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { OWNED_BINDING_SEPARATOR } from "@pithy-sh/core/src/naming/limits";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { workflowHostName } from "@pithy-sh/core/src/workflow/naming";
import { HOST_WORKERS, hostOwnerFor } from "../capabilities/hostRegistry";
import { hostedWorkflowEntries } from "../feature/hosts";
import { composeFor } from "../project/composeFor";
import { allCapabilities, loadProject, loadProjectEnvironments, requireProjectName } from "../project/config";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";

/**
 * **Does each Worker's Workflow or service binding into a capability host reach the host that reads its database?**
 *
 * A Worker that owns a binding its capability's host binds — `DB` for email and audit — writes its jobs and rows
 * into its own database, and gets a host of its own that reads them (`<project>-<env>-<owner>---<capability>`). A
 * stanza still binding the shared host is what a project deployed before that looks like: the Worker enqueues its
 * sign-in emails where the shared host never looks, and its audit chain is never checkpointed. The mirror is a
 * Worker that took the binding back out of `ownBindings` and still binds its own host.
 *
 * Established from files alone — the root config, each Worker's composition and its declared environments'
 * stanzas — against the entries `pithy provision` writes, from the same composer. **It fails the exit**: the jobs
 * never run, and nothing at runtime says so. A binding into a script that is no kit host of the capability is the
 * adopter's, and is not reported. `dev` is not here: the local hosts are wired by `pithy dev` on every run.
 */
export type HostBindingsState =
  /** Every binding reaches the host that reads its Worker's database. */
  | "ok"
  /** A binding reaches the kit host that reads another database. */
  | "stale"
  /** The root config would not load, or the Worker set would not enumerate. Never fails the exit. */
  | "could-not-check";

/** One Workflow or service binding into the host that reads another database. */
export interface StaleHostBinding {
  /** The `apps/<dir>` basename. */
  worker: string;
  /** The declared environment whose stanza holds it. */
  env: string;
  /** The binding, e.g. `EMAIL_SENDER`. */
  binding: string;
  /** The capability whose host it reaches. */
  capability: string;
  /** The host script the stanza binds. */
  boundTo: string;
  /** The host script that reads this Worker's database. */
  expected: string;
}

/** What `doctor` learned about the project's bindings into the kit hosts. */
export interface HostBindingsCheck {
  state: HostBindingsState;
  /** Every stale binding. Empty unless `state` is `stale`. */
  stale: StaleHostBinding[];
}

/** Options for {@link checkHostBindings}. */
export interface HostBindingsOptions {
  projectDir: string;
  /** Seam: the app Workers. Defaults to `discoverWorkers`. */
  workers?: readonly WorkerTarget[];
  /** Seam: the capabilities one Worker composes. Defaults to loading its `pithy.config.ts`. */
  capabilitiesFor?: (workerDir: string) => Promise<Capability[]>;
}

/** The slice of a `wrangler.jsonc` this reads. */
interface HostBindingConfig {
  env?: Record<
    string,
    | {
        workflows?: { binding?: string; script_name?: string }[];
        services?: { binding?: string; service?: string }[];
      }
    | undefined
  >;
}

/** Whether `script` is one of `capability`'s kit hosts in `env`: the shared one, or any Worker's own. */
function isKitHost(script: string, project: string, env: string, capability: string): boolean {
  const shared = resourceNames(project).env(env).worker(capability);
  if (script === shared) return true;
  const head = shared.slice(0, -capability.length);
  return script.startsWith(head) && script.endsWith(`${OWNED_BINDING_SEPARATOR}${capability}`);
}

/**
 * Check every Worker's declared environments for a Workflow binding into the wrong kit host.
 *
 * Never throws. An unreadable root config, Worker set or composition is `could-not-check`, and only when nothing
 * else was found, so a positive finding is never hidden behind it.
 */
export async function checkHostBindings(options: HostBindingsOptions): Promise<HostBindingsCheck> {
  let project: string;
  let environments: string[];
  let workers: readonly WorkerTarget[];
  try {
    const config = await loadProject(options.projectDir);
    project = requireProjectName(config);
    environments = loadProjectEnvironments(config).filter((env) => env !== LOCAL_ENVIRONMENT);
    workers = options.workers ?? (await discoverWorkers(options.projectDir));
  } catch {
    return { state: "could-not-check", stale: [] };
  }
  const capabilitiesFor =
    options.capabilitiesFor ??
    ((dir: string) => composeFor(LOCAL_ENVIRONMENT, async (load) => allCapabilities(await load(dir))));

  const stale: StaleHostBinding[] = [];
  let unreadable = false;
  for (const target of workers) {
    if (target.hasWrangler !== true) continue;
    let config: HostBindingConfig;
    let capabilities: Capability[];
    try {
      config = (await readWranglerConfig(target.dir)) as HostBindingConfig;
      capabilities = await capabilitiesFor(target.dir);
    } catch {
      unreadable = true;
      continue;
    }
    for (const env of environments) {
      const stanza = config.env?.[env];
      if (stanza === undefined) continue;
      let entries: ReturnType<typeof hostedWorkflowEntries>;
      try {
        entries = hostedWorkflowEntries(capabilities, environmentScope(project, env), target);
      } catch {
        // A Worker whose ownBindings split a host's paired bindings is refused by provision, which names it.
        unreadable = true;
        continue;
      }
      for (const expected of entries) {
        const bound = (stanza.workflows ?? []).find((entry) => entry.binding === expected.binding)?.script_name;
        if (bound === undefined || bound === expected.script_name) continue;
        if (!isKitHost(bound, project, env, expected.capability)) continue;
        stale.push({
          worker: basename(target.dir),
          env,
          binding: expected.binding,
          capability: expected.capability,
          boundTo: bound,
          expected: expected.script_name,
        });
      }
      // A service binding reaches a kit host the same way, and the same host must answer it.
      for (const entry of stanza.services ?? []) {
        if (entry.binding === undefined || entry.service === undefined) continue;
        const spec = HOST_WORKERS.find((candidate) =>
          isKitHost(entry.service as string, project, env, candidate.capability),
        );
        if (spec === undefined) continue;
        const composed =
          capabilities.find((capability) => capability.name === spec.capability) ??
          ({ name: spec.capability, requiredBindings: [] } as unknown as Capability);
        const owner = hostOwnerFor(spec, composed, target, { refuseSplit: false })?.worker;
        const expected = workflowHostName({ project, capability: spec.capability, env, ...(owner ? { owner } : {}) });
        if (entry.service === expected) continue;
        stale.push({
          worker: basename(target.dir),
          env,
          binding: entry.binding,
          capability: spec.capability,
          boundTo: entry.service,
          expected,
        });
      }
    }
  }

  if (stale.length > 0) return { state: "stale", stale };
  return { state: unreadable ? "could-not-check" : "ok", stale: [] };
}

/** One stale binding in a sentence, without the Worker: the report puts it in the label column. */
export function describeHostBinding(entry: StaleHostBinding): string {
  return `binds ${entry.binding} in ${entry.env} to ${entry.boundTo}, which reads another database, so its ${entry.capability} work runs against the wrong one. It belongs on ${entry.expected}.`;
}
