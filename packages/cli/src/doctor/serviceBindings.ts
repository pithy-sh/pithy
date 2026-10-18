// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Command, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { hostWorkerFor } from "../capabilities/hostRegistry";
import { loopSentence, serviceLoops } from "../project/serviceGraph";
import { readServiceProject, type ServiceProjectOptions } from "../project/workerBind";

/**
 * **Does every service binding an app declares reach a Worker that will be there?** (#617)
 *
 * `pithy worker bind` refuses the three faults below before it writes anything. A `pithy.config.ts` edited by
 * hand is refused by nothing, so this is where they surface, from files alone:
 *
 * - **A loop.** `app-a -> app-b -> app-a`, or longer. Printed with the same path and in the same words the bind
 *   refusal uses, because it is the same finding arriving later. A self binding is #616's and never a loop here.
 * - **A target that is no Worker.** A declared `service` naming neither an `apps/` Worker nor a kit Worker: the
 *   rename that left a binding behind, or a typo. Provisioning refuses it; this says so first.
 * - **A kit Worker nothing composes.** The capability was removed and the binding was not. Its host is not
 *   deployed, so the binding names a script nobody ships.
 *
 * Each fails the exit: the consequence of every one is a deploy that refuses or a call that cannot land, and the
 * project's own files establish it.
 */
export type ServiceBindingFaultKind = "loop" | "missing-target" | "uncomposed";

/** One fault, anchored on the Worker holding the binding. */
export interface ServiceBindingFault {
  kind: ServiceBindingFaultKind;
  /** The `apps/` Worker holding the binding — for a loop, the first Worker of its path. */
  worker: string;
  /** The binding name, or `null` for a loop, which is several. */
  binding: string | null;
  /** The Worker the binding calls, or `null` for a loop. */
  target: string | null;
  /** The loop, closed on itself, or `null` for every other kind. */
  path: string[] | null;
}

/** What `doctor` learned about the project's service bindings. */
export interface ServiceBindingsCheck {
  state: "ok" | "faulty" | "could-not-check";
  faults: ServiceBindingFault[];
}

/**
 * Check every declared service binding. Never throws: an unreadable project is `could-not-check`, which never
 * fails the exit. A Worker whose config will not load still counts, through the literal declarations in its file.
 */
export async function checkServiceBindings(options: ServiceProjectOptions): Promise<ServiceBindingsCheck> {
  let project: Awaited<ReturnType<typeof readServiceProject>>;
  try {
    project = await readServiceProject(options);
  } catch {
    return { state: "could-not-check", faults: [] };
  }
  const apps = new Set(project.workers.map((worker) => worker.app));
  const faults: ServiceBindingFault[] = [];
  for (const edge of project.edges) {
    if (edge.from === edge.to || apps.has(edge.to)) continue;
    const kit = hostWorkerFor(edge.to) !== undefined;
    if (kit && project.kit.includes(edge.to)) continue;
    faults.push({
      kind: kit ? "uncomposed" : "missing-target",
      worker: edge.from,
      binding: edge.binding,
      target: edge.to,
      path: null,
    });
  }
  for (const path of serviceLoops(project.edges)) {
    faults.push({ kind: "loop", worker: path[0] as string, binding: null, target: null, path });
  }
  return { state: faults.length > 0 ? "faulty" : "ok", faults };
}

/** One fault in a sentence, without the Worker: the report puts it in the label column. A loop names its own. */
export function describeServiceBinding(fault: ServiceBindingFault): string {
  if (fault.kind === "loop" && fault.path) {
    const path = fault.path;
    return loopSentence(path[path.length - 2] as string, path[0] as string, path);
  }
  if (fault.kind === "uncomposed") {
    return `binds ${fault.binding} to ${fault.target}, and no Worker composes ${fault.target}, so its Worker is not deployed.`;
  }
  return `binds ${fault.binding} to ${fault.target}, which is no Worker of this project.`;
}

/** One fault as a whole sentence, the Worker included — a fault's `detail` in `--json` and in the exit's list. */
export function serviceBindingDetail(fault: ServiceBindingFault): string {
  return fault.kind === "loop" ? describeServiceBinding(fault) : `${fault.worker} ${describeServiceBinding(fault)}`;
}

/**
 * The command that rights a fault, or `null` where the remedy is a choice: which binding of a loop goes, or
 * whether a capability that was removed comes back. A binding to nothing is unbound.
 */
export function serviceBindingFix(fault: ServiceBindingFault): Command | null {
  if (fault.kind !== "missing-target" || fault.binding === null) return null;
  return pithyCommand("worker unbind", { flags: { "--from": fault.worker, "--binding": fault.binding } });
}
