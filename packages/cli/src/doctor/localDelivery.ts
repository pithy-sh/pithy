// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { HOST_WORKERS, hostOwnerFor } from "../capabilities/hostRegistry";
import {
  type ChildCloudflareIdentity,
  projectChildCloudflareIdentity as defaultChildCloudflareIdentity,
  deliveryPreflight,
  deliveryVerdictLines,
  type HostDeliveryVerdict,
} from "../dev/delivery";
import { ownedHostName } from "../dev/hostWorkers";

/**
 * Whether local email delivery is **live** — the question `pithy doctor` answers about a machine, and
 * the one nothing else in the report asks.
 *
 * `Settings:` says whether the values work. Every other block says whether something is there. Neither
 * says the thing a developer actually wants to know before they sit waiting on an inbox: does a magic
 * link triggered from localhost leave this machine, or is it written to disk. That depends on a
 * Cloudflare login and on the delivery mode the config selected, and both are readable here for free.
 *
 * **It is the same function `pithy dev` decides with.** {@link deliveryPreflight} returns the verdict
 * and its wording, and this hands back exactly what it said — so doctor and the dev command cannot come
 * to two answers about one project, and a rule that changes changes in one file. Which capability
 * answers for delivery is the host registry's, not this module's: a tenth capability that puts
 * something on the wire implements `delivery` and is reported here with no change.
 *
 * It is not a fault. The simulator is a legitimate choice — `email({ devDelivery: "simulator" })` picks
 * it deliberately, and an offline machine has no other option — so this never fails the exit. It prints
 * because silence would be read as "of course it sends".
 */

/** What this machine would do with a message, and the words the run said it in. */
export interface LocalDeliveryCheck {
  /** Whether a message sent from localhost actually leaves the machine, from every host that sends one. */
  live: boolean;
  /** The capability that answers for delivery — `email` today, the only one holding a send binding. */
  capability: string;
  /** The verdict verbatim: the same lines `pithy dev` prints in its ready banner, action included. */
  lines: string[];
  /**
   * Each sending host's own verdict, by its dev-set name: the shared host from the Workers that share it, and a
   * Worker's own host from that Worker's config.
   */
  hosts: { name: string; live: boolean; lines: string[] }[];
}

/** Everything the check reads, all of it injectable so a unit test never touches a credential file. */
export interface LocalDeliveryOptions {
  projectDir: string;
  /**
   * The Workers in scope, with the capability instances doctor already resolved, and what each owns: a Worker that
   * owns a binding a sending host binds has a host of its own, decided by its own config.
   */
  workers: readonly {
    dir?: string;
    target?: { ownBindings?: readonly string[] };
    capabilities: readonly Capability[];
  }[];
  /**
   * Seam: what a worker `pithy dev` starts would authenticate as. Defaults to the dev command's own reader.
   *
   * The *child's* identity, not the CLI's, and the two can differ: the project's pinned account replaces whatever
   * the shell exports. Doctor reports on the machine a dev session would run on, so it asks the question that
   * session will answer.
   */
  cloudflare?: (projectDir: string, env: NodeJS.ProcessEnv) => Promise<ChildCloudflareIdentity>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The delivery verdict for this project, or `null` when nothing composed puts a message on the wire.
 *
 * `null` is the ordinary case and is silent: a project with no sending capability has no local delivery
 * to be right or wrong about. A capability whose package will not load answers nothing rather than
 * failing the report — the `Settings:` block reaches the same package on the same run and names it.
 */
export async function checkLocalDelivery(options: LocalDeliveryOptions): Promise<LocalDeliveryCheck | null> {
  // Asked once, and only once a host has something to send: every verdict is judged against the same login.
  let cloudflare: ChildCloudflareIdentity | undefined;
  for (const spec of HOST_WORKERS) {
    if (!spec.delivery) continue;
    // The hosts `pithy dev` runs for this capability: the first sharing Worker's composition, and each owner's own.
    const hosts: { name: string; capability: Capability }[] = [];
    for (const worker of options.workers) {
      const capability = worker.capabilities.find((one) => one.name === spec.capability);
      if (!capability) continue;
      const owner =
        worker.dir === undefined
          ? undefined
          : hostOwnerFor(
              spec,
              capability,
              { dir: worker.dir, ownBindings: worker.target?.ownBindings ?? [] },
              { refuseSplit: false },
            )?.worker;
      const name = owner ? ownedHostName(owner, spec.capability) : spec.capability;
      if (!hosts.some((host) => host.name === name)) hosts.push({ name, capability });
    }
    if (hosts.length === 0) continue;
    hosts.sort((left, right) => Number(left.name !== spec.capability) - Number(right.name !== spec.capability));
    const verdicts: HostDeliveryVerdict[] = [];
    for (const host of hosts) {
      let identity: Awaited<ReturnType<NonNullable<typeof spec.delivery>>>;
      try {
        identity = await spec.delivery(host.capability, options.projectDir);
      } catch {
        continue;
      }
      if (!identity) continue;
      cloudflare ??= await (options.cloudflare ?? defaultChildCloudflareIdentity)(
        options.projectDir,
        options.env ?? process.env,
      );
      verdicts.push({
        name: host.name,
        preflight: deliveryPreflight({
          composed: true,
          requested: identity.requested,
          ...(identity.fromAddress !== undefined ? { fromAddress: identity.fromAddress } : {}),
          cloudflare,
        }),
      });
    }
    if (verdicts.length === 0) continue;
    return {
      live: verdicts.every((verdict) => verdict.preflight.live),
      capability: spec.capability,
      lines: deliveryVerdictLines(verdicts),
      hosts: verdicts.map(({ name, preflight }) => ({ name, live: preflight.live, lines: preflight.lines })),
    };
  }

  return null;
}

/** The check as one sentence — the `--json` `detail`, and never a second wording of the lines. */
export function describeLocalDelivery(check: Pick<LocalDeliveryCheck, "lines">): string {
  return check.lines.join(" ").replace(/\s+/g, " ").trim();
}
