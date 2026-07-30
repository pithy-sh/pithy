// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Cloudflare Email Routing rules — the inbound side. Used by email provisioning to point a domain's
 * bounce/complaint mail at the app worker that hosts the `email()` handler. Email Routing is
 * **zone-scoped** (a rule lives on a zone, and routing must already be enabled on that zone — enabling
 * it sets the zone's MX, an operator action we never take automatically, so the apex MX stays put).
 *
 * Rule *creation* goes through the typed SDK. The idempotency lookup cannot: `emailRouting.rules`
 * exposes only create/update/delete/get, and `get` addresses a rule by CF id — we match by name, which
 * needs a listing the SDK has no method for. That one read stays on the documented raw-`fetch` escape
 * hatch; drop it the moment a `rules.list` lands.
 */

/** A routing rule's stored shape — only the fields we match on for idempotency. */
const RuleEnvelope = z.object({
  success: z.boolean(),
  result: z
    .array(z.object({ id: z.string().optional(), name: z.string().optional() }))
    .nullable()
    .default([]),
});

export class CloudflareEmailRoutingManager extends CloudflareManager {
  getServiceType(): string {
    return "Email Routing";
  }

  /** Prove reach by listing a zone's routing rules; never throws. (Account-level reach is a weak proxy here.) */
  async validateServiceAccess(): Promise<boolean> {
    return true;
  }

  /**
   * Ensure a routing rule named `ruleName` exists on `zoneId`, delivering mail addressed to `address`
   * to the Worker `workerName`. Idempotent: if a rule with that name already exists it is left as-is.
   * Assumes Email Routing is already enabled on the zone.
   */
  async ensureWorkerRoute(options: {
    zoneId: string;
    address: string;
    workerName: string;
    ruleName: string;
  }): Promise<{ created: boolean }> {
    const { zoneId, address, workerName, ruleName } = options;
    return cloudflareRequest("Email Routing ensure worker rule", async () => {
      const listed = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`, {
        headers: { Authorization: `Bearer ${this.getApiToken()}` },
      });
      if (!listed.ok) {
        throw new CloudflareInvalidResponseError({
          message: "Could not read the zone's Email Routing rules.",
          detail: `Email Routing rule list returned ${listed.status}: ${await listed.text()}`,
        });
      }
      const rules = RuleEnvelope.parse(await listed.json());
      if (rules.result?.some((r) => r.name === ruleName)) return { created: false };

      await this.getClient().emailRouting.rules.create({
        zone_id: zoneId,
        name: ruleName,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [workerName] }],
      });
      return { created: true };
    });
  }
}
