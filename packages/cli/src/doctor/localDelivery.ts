// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { hasCloudflareLogin as defaultHasCloudflareLogin, deliveryPreflight } from "../dev/delivery";

/**
 * Whether local email delivery is **live** — the question `pithy doctor` answers about a machine, and
 * the one nothing else in the report asks (pithy-sh/pithy#410).
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
  /** Whether a message sent from localhost actually leaves the machine. */
  live: boolean;
  /** The capability that answers for delivery — `email` today, the only one holding a send binding. */
  capability: string;
  /** The verdict verbatim: the same lines `pithy dev` prints in its ready banner, action included. */
  lines: string[];
}

/** Everything the check reads, all of it injectable so a unit test never touches a credential file. */
export interface LocalDeliveryOptions {
  projectDir: string;
  /** The Workers in scope, with the capability instances doctor already resolved. */
  workers: readonly { capabilities: readonly Capability[] }[];
  /** Seam: whether Cloudflare credentials resolve at all. Defaults to the dev command's own reader. */
  hasCloudflareLogin?: (projectDir: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
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
  const composed = new Map<string, Capability>();
  for (const worker of options.workers) {
    for (const capability of worker.capabilities) {
      if (!composed.has(capability.name)) composed.set(capability.name, capability);
    }
  }

  for (const spec of HOST_WORKERS) {
    const capability = composed.get(spec.capability);
    if (!capability || !spec.delivery) continue;
    let identity: Awaited<ReturnType<NonNullable<typeof spec.delivery>>>;
    try {
      identity = await spec.delivery(capability);
    } catch {
      continue;
    }
    if (!identity) continue;
    const preflight = deliveryPreflight({
      composed: true,
      requested: identity.requested,
      ...(identity.fromAddress !== undefined ? { fromAddress: identity.fromAddress } : {}),
      hasCloudflareLogin: await (options.hasCloudflareLogin ?? defaultHasCloudflareLogin)(
        options.projectDir,
        options.env ?? process.env,
      ),
    });
    return { live: preflight.live, capability: spec.capability, lines: preflight.lines };
  }

  return null;
}

/** The check as one sentence — the `--json` `detail`, and never a second wording of the lines. */
export function describeLocalDelivery(check: LocalDeliveryCheck): string {
  return check.lines.join(" ").replace(/\s+/g, " ").trim();
}
