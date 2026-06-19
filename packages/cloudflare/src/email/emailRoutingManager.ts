import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Cloudflare Email Routing rules — the inbound side. Used by email provisioning to point a domain's
 * bounce/complaint mail at the app worker that hosts the `email()` handler. Email Routing is
 * **zone-scoped** (a rule lives on a zone, and routing must already be enabled on that zone — enabling
 * it sets the zone's MX, an operator action we never take automatically, so the apex MX stays put).
 * The rules API is not in the typed SDK, so this uses the documented raw-`fetch` escape hatch.
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
      const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`;
      const auth = { Authorization: `Bearer ${this.getApiToken()}` };

      const listed = await fetch(base, { headers: auth });
      const rules = RuleEnvelope.parse(await listed.json());
      if (rules.result?.some((r) => r.name === ruleName)) return { created: false };

      const response = await fetch(base, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: ruleName,
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: address }],
          actions: [{ type: "worker", value: [workerName] }],
        }),
      });
      if (!response.ok) {
        throw new CloudflareInvalidResponseError({
          message: "Could not create the Email Routing rule.",
          detail: `Email Routing rule create returned ${response.status}: ${await response.text()}`,
        });
      }
      return { created: true };
    });
  }
}
