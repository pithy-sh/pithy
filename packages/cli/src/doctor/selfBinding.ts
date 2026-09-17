// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { SELF_BINDING } from "@pithy-sh/core/src/worker/identity";
import { administersItself, loadProject, loadProjectEnvironments } from "../project/config";
import { identityOf, type WranglerShape } from "../project/effectiveConfig";
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
 * **A binding is its target, not its name.** An entry called `SELF` naming a script the stanza does not
 * deploy as is the same fault as no entry at all, and a worse one to read: it provisions clean, reports
 * success, and dispatches into another Worker — or into nothing — at runtime. The writer composes that
 * string from the `name` it settles in the same edit, so the two agree the instant provisioning runs; what
 * this reader is for is every edit afterwards. `pithy worker rename` moves a stanza's `name`, and an
 * adopter may write one by hand (#580 exists so that a hand-written name wins), so the pairing has to be
 * established here rather than assumed.
 *
 * **What it deliberately does not report.** An environment with no stanza at all is `checkEnvironments`'
 * finding; two blocks reporting one fault is how a report starts contradicting itself. A feature
 * environment is not here either: its stanza is generated on every run, under the ignored `.wrangler/`,
 * so there is nothing in the checkout to have drifted.
 *
 * **`dev` is excluded, and deliberately.** The top-level stanza gets no binding, and that is not an
 * oversight this check should report. The 522 is an *edge* behavior: a Worker reaching its own public
 * hostname leaves the isolate and loops back through Cloudflare. Locally there is no edge — `wrangler dev`
 * serves a Worker fetching its own address as an ordinary request, in milliseconds — so a dev run needs no
 * binding, and a call site that wants one falls back to the global fetch there. Reporting `dev` would be
 * demanding configuration for a failure that cannot happen in it.
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
  /** What its `SELF` entry names, or `null` when there is no entry or it names nothing. */
  boundTo: string | null;
  /** The script this stanza deploys as, by wrangler's own rules, or `null` when the file does not say. */
  deploysAs: string | null;
}

/** What `doctor` learned about this project's self binding. */
export interface SelfBindingCheck {
  state: SelfBindingState;
  /** Whether the root config declares self-administration at all. `false` is the ordinary state. */
  declared: boolean;
  /** Every stanza that should carry the binding and does not. Empty unless `state` is `unbound`. */
  missing: UnboundStanza[];
}

/**
 * The `wrangler.jsonc` keys this reads: each stanza's `services` array, and the two `identityOf` needs to
 * answer what a stanza deploys as — the top-level `name` a nameless stanza inherits `<name>-<env>` from.
 */
interface BoundWorkerConfig extends WranglerShape {
  env?: Record<string, (WranglerShape & { services?: { binding?: string; service?: string }[] }) | undefined>;
}

/** What one stanza's `SELF` entry names, `null` when there is no entry or it names nothing. */
function selfTarget(stanza: { services?: { binding?: string; service?: string }[] } | undefined): string | null {
  const entry = (stanza?.services ?? []).find((candidate) => candidate.binding === SELF_BINDING);
  return typeof entry?.service === "string" && entry.service !== "" ? entry.service : null;
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
      const boundTo = selfTarget(stanza);
      // wrangler's own answer, from the module the rest of the kit asks — never a name composed here,
      // which would be a second producer of the string this check exists to hold the first one to.
      const deploysAs = identityOf(target.dir, config, env, false).name;
      // A file naming no script anywhere says nothing to compare against, and a finding built on that
      // would be this check inventing the fact it is reporting. Presence is all there is to establish.
      if (deploysAs === null ? boundTo !== null : boundTo === deploysAs) continue;
      missing.push({ worker, env, boundTo, deploysAs });
    }
  }

  if (missing.length > 0) return { state: "unbound", declared: true, missing };
  return { state: unreadable ? "could-not-check" : "ok", declared: true, missing: [] };
}

/**
 * One unbound stanza in a sentence — what is wrong, and what it is for.
 *
 * Two faults, two sentences. An absent binding is a line nobody wrote; a misdirected one is a line that
 * looks right, and naming both scripts is the whole of what makes it readable — an operator comparing
 * them sees the rename or the hand-edit that moved one and not the other.
 */
export function describeSelfBinding(entry: UnboundStanza): string {
  if (entry.boundTo === null) {
    return `${entry.env} binds no ${SELF_BINDING} — the project administers itself, and a Worker cannot fetch its own hostname.`;
  }
  return `${entry.env} binds ${SELF_BINDING} to ${entry.boundTo}, and deploys as ${entry.deploysAs ?? "nothing this file names"} — a binding naming a script nobody deploys refuses at runtime.`;
}
