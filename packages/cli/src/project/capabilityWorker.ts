// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { capabilityNotComposed } from "../capabilities/notComposed";
import { workerIdentity } from "./workerIdentity";
import { type ResolvedWorker, type ResolveSingleOptions, resolveSingleWorker } from "./workerScope";

/**
 * **The one Worker a capability command acts on, and that same Worker's capability** (#590 review).
 *
 * A command that provisions a capability reads its config and writes into a Worker: bindings, a provisioning
 * record, readiness, a sitekey. Five commands read the config from *the first Worker in the project composing
 * the capability* and wrote into `resolveSingleWorker({ worker })`. With two Workers, `pithy vector provision
 * --worker web` created `api`'s indexes and recorded them in `web`, which composed no vector at all, while
 * `api` — the Worker that checks `VECTOR_PROVISIONED` at boot — got no record. `pithy turnstile provision` had
 * the same split, fixed on its own first.
 *
 * One resolution answers both, so they cannot disagree: the Worker `--worker` names (or the project's only
 * one), and the capability off **that Worker's** composition. A Worker that does not compose it is refused by
 * name. The config is never borrowed from a sibling.
 *
 * ## What it does not decide
 *
 * A capability whose provisioned resource belongs to the project rather than to one Worker — the email host,
 * the testers pass — reads the project's composition on purpose, and does not come through here.
 */

/** Options for {@link resolveCapabilityWorker}. */
export interface ResolveCapabilityWorkerOptions<C extends Capability> extends ResolveSingleOptions {
  /** The capability's name, as `pithy add` takes it — used in the refusal. */
  name: string;
  /** The capability's own guard, from the project's installed package. */
  is: (capability: Capability) => capability is C;
}

/** The resolved Worker, and the capability as that Worker composes it. */
export interface CapabilityWorker<C extends Capability> {
  worker: ResolvedWorker;
  capability: C;
}

/** Resolve the target Worker, and refuse unless it composes the capability. */
export async function resolveCapabilityWorker<C extends Capability>(
  options: ResolveCapabilityWorkerOptions<C>,
): Promise<CapabilityWorker<C>> {
  const { name, is, ...resolve } = options;
  const worker = await resolveSingleWorker(resolve);
  const capability = worker.capabilities.find(is);
  if (!capability) {
    // Named by its apps/ directory, the value every `--worker` in the sentence takes. The `pithy add` in the
    // sentence is the one the refusal's `fix` carries, from one builder (#711).
    const dir = workerIdentity(worker).worker;
    const missing = capabilityNotComposed(
      name,
      {
        message: `${worker.name} does not compose the ${name} capability.`,
        action: (add) =>
          `Add \`${name}({ ... })\` to ${dir}'s pithy.config.ts (run ${add}), or name the Worker that composes it with --worker.`,
      },
      { projectDir: resolve.projectDir, workerDir: worker.dir },
    );
    // **Two different mistakes (#697).** A Worker the caller named is a call another `--worker` fixes: exit 2. The
    // Worker the project resolved to on its own lacks what the call depends on: exit 3, and `pithy add` is the step.
    if (resolve.worker !== undefined)
      throw new ValidationError({ message: missing.payload.message, action: missing.payload.action });
    throw missing;
  }
  return { worker, capability };
}
