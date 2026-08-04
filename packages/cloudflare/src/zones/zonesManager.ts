// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * The account's zones — the registrable domains a custom domain can attach to.
 *
 * **Nothing here listed zones before.** Every zone-scoped operation in this package takes a `zoneId` the
 * caller already knows: `CloudflareCustomHostnamesManager` takes it as constructor config,
 * `CloudflareEmailRoutingManager` takes it per method, `CloudflareWorkersManager.addRoute` takes it
 * positionally — and `pithy email provision` makes a human paste one, telling them to "find it on the
 * zone's Overview page". So the CLI never *discovered* a zone; it demanded one.
 *
 * That is what this exists to change. When `pithy init` and `pithy worker add` ask where a Worker will
 * answer, offering the account's real zones means a typo fails at `init` with a list of what exists,
 * rather than at `deploy` with a Cloudflare error to decode.
 *
 * Read-only, deliberately. Pithy attaches routes to zones and never creates, transfers, or deletes one —
 * a zone is the adopter's relationship with their registrar, not a resource this toolset provisions. The
 * scoped token needs only `Zone:Read`.
 */

/** One zone on the account. */
export const ZoneInfo = z
  .object({
    id: z.string().describe("The CF-assigned zone id, which every zone-scoped API call is addressed by."),
    name: z
      .string()
      .describe(
        "The registrable domain, e.g. `example.com`. This is the value a Worker's `domains` declaration names as its `zone`, and what wrangler writes as `zone_name`.",
      ),
    status: z
      .string()
      .describe(
        "The zone's lifecycle status — `active` once Cloudflare is serving it, otherwise `pending`, `initializing`, or `moved`. A non-active zone cannot carry a custom domain yet, so a picker shows it and says so rather than hiding it.",
      ),
  })
  .describe("One Cloudflare zone: the registrable domain a custom domain can attach to, and whether it is live.");
export type ZoneInfo = z.output<typeof ZoneInfo>;

/** Read the account's zones. Never creates or deletes — a zone is the adopter's, not ours to provision. */
export class CloudflareZonesManager extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare Zones";
  }

  /** Prove access by listing. A read, and never throws — the caller decides what an inaccessible account means. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.listZones();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every zone on this account, name-sorted so a picker is stable between runs.
   *
   * Filtered to the account, because a user-bound token can see zones on accounts this project has
   * nothing to do with — offering those would invite someone to attach a Worker to a zone that another
   * account owns, which fails at deploy with an error that names neither problem.
   */
  async listZones(): Promise<ZoneInfo[]> {
    return cloudflareRequest("list zones", async () => {
      const zones: ZoneInfo[] = [];
      for await (const zone of this.getClient().zones.list({ account: { id: this.accountId } })) {
        const parsed = ZoneInfo.safeParse(zone);
        if (parsed.success) zones.push(parsed.data);
      }
      return zones.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /**
   * The zone a hostname belongs to, or `null`.
   *
   * Matches the **longest** zone name that the hostname sits under, which is the only correct rule when
   * an account holds both `example.com` and `eu.example.com`: `api.eu.example.com` belongs to the latter,
   * and picking the first match would attach it to the wrong zone. A public-suffix guess is not used at
   * all — a zone can itself be a subdomain, and the account's own list is the authority.
   */
  async findZoneForHostname(hostname: string): Promise<ZoneInfo | null> {
    const zones = await this.listZones();
    const candidates = zones.filter((zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`));
    if (candidates.length === 0) return null;
    return candidates.reduce((longest, zone) => (zone.name.length > longest.name.length ? zone : longest));
  }
}
