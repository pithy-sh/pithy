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
 * Rule *creation and deletion* go through the typed SDK. The lookup both of them turn on cannot:
 * `emailRouting.rules` exposes only create/update/delete/get, and `get` addresses a rule by CF id — we
 * match by name, which needs a listing the SDK has no method for. That one read stays on the documented
 * raw-`fetch` escape hatch; drop it the moment a `rules.list` lands.
 */

/** A routing rule's stored shape — only the fields we match on for idempotency. */
const RuleEnvelope = z.object({
  success: z.boolean(),
  result: z
    .array(z.object({ id: z.string().optional(), name: z.string().optional() }))
    .nullable()
    .default([]),
  /**
   * The paging block. Present on every list response, and read rather than ignored because both
   * callers ask a question a truncated answer gets **wrong in the dangerous direction**: an unseen
   * rule reads as "no such rule", which makes `ensureWorkerRoute` create a duplicate on every run and
   * `removeWorkerRoute` report a removal while mail is still being delivered.
   */
  result_info: z
    .object({
      page: z.number().optional(),
      per_page: z.number().optional(),
      total_count: z.number().optional(),
      total_pages: z.number().optional(),
    })
    .nullish(),
});

/** Rules per page. Cloudflare's maximum, so the common zone is answered in one request. */
const RULES_PER_PAGE = 50;

/** A hard stop on the page loop, so a malformed `result_info` cannot spin forever. */
const MAX_RULE_PAGES = 100;

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
      const rules = await this.#listRules(zoneId);
      if (rules.some((rule) => rule.name === ruleName)) return { created: false };

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

  /**
   * Remove the rule named `ruleName` from `zoneId`, so mail stops being delivered to the Worker behind it.
   * Idempotent: a zone carrying no such rule is a no-op, which is what lets a teardown be re-run.
   *
   * **Matched on the rule name, never on the address.** The name is the key `ensureWorkerRoute` created
   * under, so the two agree on which rule belongs to which capability even after somebody edited the
   * address in the dashboard — and a teardown that matched on the address would happily delete a rule an
   * operator wrote by hand for the same mailbox.
   */
  async removeWorkerRoute(options: { zoneId: string; ruleName: string }): Promise<{ removed: boolean }> {
    const { zoneId, ruleName } = options;
    return cloudflareRequest("Email Routing remove worker rule", async () => {
      const rule = (await this.#listRules(zoneId)).find((candidate) => candidate.name === ruleName);
      if (!rule?.id) return { removed: false };
      await this.getClient().emailRouting.rules.delete(rule.id, { zone_id: zoneId });
      return { removed: true };
    });
  }

  /**
   * **Every** routing rule on a zone, by the raw-`fetch` escape hatch this file's header documents —
   * the SDK has no listing, and both matching by name and deleting by id need one.
   *
   * Paged to exhaustion rather than reading the first page. A zone with more rules than fit one page
   * is unusual but entirely legal, and a partial read is not a smaller answer here — it is a *wrong*
   * one, because both callers treat "not in the list" as "does not exist". Provisioning would then
   * create a second rule for the same address on every run, and a teardown would report mail stopped
   * while it kept arriving.
   *
   * A failed read **throws**, for the same reason: silently degrading to an empty list would produce
   * exactly the two failures above.
   */
  async #listRules(zoneId: string): Promise<{ id?: string; name?: string }[]> {
    const rules: { id?: string; name?: string }[] = [];

    for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
      const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${RULES_PER_PAGE}`;
      const listed = await fetch(url, { headers: { Authorization: `Bearer ${this.getApiToken()}` } });
      if (!listed.ok) {
        throw new CloudflareInvalidResponseError({
          message: "Could not read the zone's Email Routing rules.",
          detail: `Email Routing rule list returned ${listed.status}: ${await listed.text()}`,
        });
      }

      const envelope = RuleEnvelope.parse(await listed.json());
      const batch = envelope.result ?? [];
      rules.push(...batch);

      // Stop on the paging block when the API supplied one, and on a short page otherwise — an older
      // or proxied response that omits `result_info` still terminates correctly.
      const totalPages = envelope.result_info?.total_pages;
      if (totalPages !== undefined ? page >= totalPages : batch.length < RULES_PER_PAGE) break;
    }

    return rules;
  }
}
