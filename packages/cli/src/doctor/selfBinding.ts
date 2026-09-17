// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { SELF_BINDING } from "@pithy-sh/core/src/worker/identity";
import { administersItself, loadProject, loadProjectEnvironments } from "../project/config";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";

/**
 * **Does a project that administers itself have the binding it needs to?** (#616)
 *
 * A Worker cannot fetch its own hostname. The subrequest leaves the isolate, loops back through the edge
 * into the Worker it came from, and hangs until Cloudflare answers 522 — on a route that answers from
 * outside in a second and a half. The remedy is a service binding to itself, dispatched inside the
 * runtime, and `pithy provision` writes one into every stanza it generates for a project whose root config
 * declares `administersItself`.
 *
 * So the finding is a contradiction between the project's own two files: the root config says the project
 * administers itself, and a stanza it deploys from has no binding to do it with. That is worth failing the
 * exit over for the reason a Workflows drift is — the consequence is a timeout at runtime, in production,
 * which every dashboard and every log line attributes to Cloudflare rather than to a missing line in a
 * config. The remedy is one command, and it is the command that was going to be run anyway.
 *
 * **What it deliberately does not report.** An environment with no stanza at all is `checkEnvironments`'
 * finding; two blocks reporting one fault is how a report starts contradicting itself. A feature
 * environment is not here either: its stanza is generated on every run, under the ignored `.wrangler/`,
 * so there is nothing in the checkout to have drifted.
 */
export type SelfBindingState =
  /** Either the project declares nothing, or every stanza it declares carries the binding. */
  | "ok"
  /** The root config would not load, or the worker set would not enumerate. Never fails the exit. */
  | "could-not-check"
  /** A declared self-administering project has a stanza without it. Established from files alone. */
  | "unbound";

/** One environment stanza that should carry the self binding and does not. */
export interface UnboundStanza {
  /** The `apps/<dir>` basename — the anchor every other Worker finding uses. */
  worker: string;
  /** The declared environment whose stanza is missing it. */
  env: string;
}

/** What `doctor` learned about this project's self binding. */
export interface SelfBindingCheck {
  state: SelfBindingState;
  /** Whether the root config declares self-administration at all. `false` is the ordinary state. */
  declared: boolean;
  /** Every stanza that should carry the binding and does not. Empty unless `state` is `unbound`. */
  missing: UnboundStanza[];
}

/** The `wrangler.jsonc` keys this reads: each stanza's `services` array, and nothing else. */
interface BoundWorkerConfig {
  env?: Record<string, { services?: { binding?: string }[] } | undefined>;
}

/** Whether one stanza binds the kit's own constant — a capability's own service bindings are not it. */
function bindsSelf(stanza: { services?: { binding?: string }[] } | undefined): boolean {
  return (stanza?.services ?? []).some((entry) => entry.binding === SELF_BINDING);
}

/**
 * Check a project's declared environments for the self binding its root config asks for.
 *
 * Never throws. A diagnostic has to work in the broken project it exists to diagnose, so an unreadable
 * root config or `wrangler.jsonc` becomes `could-not-check` — and only when nothing else was found, since
 * degrading a positive finding into "I could not check" would hide the fault behind the noise.
 */
export async function checkSelfBinding(projectDir: string): Promise<SelfBindingCheck> {
  let declared: boolean;
  let environments: string[];
  try {
    const config = await loadProject(projectDir);
    declared = administersItself(config);
    environments = [...loadProjectEnvironments(config)];
  } catch {
    return { state: "could-not-check", declared: false, missing: [] };
  }
  // Declared, never inferred: a project that has not said so is not half-configured, it is a project that
  // wants none of this, and a finding here would be an opinion about somebody else's architecture.
  if (!declared) return { state: "ok", declared: false, missing: [] };

  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { state: "could-not-check", declared: true, missing: [] };
  }

  const missing: UnboundStanza[] = [];
  let unreadable = false;
  for (const target of workers) {
    if (!target.hasWrangler) continue; // a non-Worker process in the dev set has no stanza to bind in
    let config: BoundWorkerConfig;
    try {
      config = (await readWranglerConfig(target.dir)) as BoundWorkerConfig;
    } catch {
      unreadable = true;
      continue;
    }
    const worker = basename(target.dir);
    for (const env of environments) {
      const stanza = config.env?.[env];
      // A stanza that is not there is `checkEnvironments`' finding. This one is about what is inside one.
      if (stanza === undefined) continue;
      if (!bindsSelf(stanza)) missing.push({ worker, env });
    }
  }

  if (missing.length > 0) return { state: "unbound", declared: true, missing };
  return { state: unreadable ? "could-not-check" : "ok", declared: true, missing: [] };
}

/** One unbound stanza in a sentence — what is missing, and what it is for. */
export function describeSelfBinding(entry: UnboundStanza): string {
  return `${entry.env} binds no ${SELF_BINDING} — the project administers itself, and a Worker cannot fetch its own hostname.`;
}
