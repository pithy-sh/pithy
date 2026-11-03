// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ZoneInfo } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import type { Capability } from "@pithy-sh/core/src/capability/capability";

/**
 * **Which zones the `ci-system` token may route inbound mail on, answered from the composition.**
 *
 * Email Routing Rules Write, Zone Read and Zone Settings Read are zone-level groups: on the account resource they
 * grant nothing. So `ci-system` carries them as a policy over the zones that hold the addresses the composed
 * capabilities route (`Capability.inboundRouting`), found the way `pithy support provision` finds them: the longest
 * active zone name the address's domain equals or sits under.
 *
 * **An address no zone holds is left out, never a refused mint.** Routing that address is refused at provision,
 * naming the domain, and a project whose inbox is not on Cloudflare yet still mints the rest of its CI token.
 */

/** The slice of a resolved Worker this reads. */
export interface InboundRoutingWorker {
  capabilities: readonly Capability[];
}

/** Whether any composed capability routes inbound mail, with or without an address it declares. */
export function routesInboundMail(workers: readonly InboundRoutingWorker[]): boolean {
  return workers.some((worker) => worker.capabilities.some((capability) => capability.inboundRouting !== undefined));
}

/** Every inbound address the composed capabilities route, lowercased and de-duped, in worker order. */
export function declaredInboundAddresses(workers: readonly InboundRoutingWorker[]): string[] {
  const addresses: string[] = [];
  for (const worker of workers) {
    for (const capability of worker.capabilities) {
      for (const address of capability.inboundRouting?.addresses ?? []) {
        const normalized = address.toLowerCase();
        if (!addresses.includes(normalized)) addresses.push(normalized);
      }
    }
  }
  return addresses;
}

/** The zone read this needs, and the whole of it. Never a write. */
export interface ZoneDirectory {
  findActiveZoneForHostname(hostname: string): Promise<ZoneInfo | null>;
}

/**
 * The ids of the zones holding `addresses`, de-duped and sorted so declaration order cannot change the token. No
 * address means no call, so a project that receives no mail mints exactly what it minted before.
 */
export async function resolveInboundZoneIds(addresses: readonly string[], zones: ZoneDirectory): Promise<string[]> {
  const ids = new Set<string>();
  for (const address of addresses) {
    const zone = await zones.findActiveZoneForHostname(address.slice(address.lastIndexOf("@") + 1));
    if (zone) ids.add(zone.id);
  }
  return [...ids].sort();
}
