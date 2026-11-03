// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * Cloudflare Email Routing rules — the inbound side. Email provisioning points a domain's bounce/complaint mail
 * at the app worker that hosts the `email()` handler, keyed on the rule's name; support provisioning routes an
 * exact address to an environment's app worker, keyed on the address. Email Routing is **zone-scoped**: a rule
 * lives on the zone that holds the domain, the parent zone for a subdomain, and routing must already be enabled
 * for the domain. Enabling it sets the domain's MX, an operator action nothing here takes.
 *
 * Rule creation, update and deletion, and the settings and DNS reads, go through the typed SDK. The rule lookup
 * cannot: `emailRouting.rules` exposes only create/update/delete/get, and `get` addresses a rule by CF id, while
 * every caller here matches on a name or an address, which needs a listing the SDK has no method for. That one
 * read stays on the documented raw-`fetch` escape hatch, against the SDK's base URL; drop it the moment a
 * `rules.list` lands.
 */

/** A routing rule's stored shape — the fields matching by name, by address and by target read. */
const ListedRule = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  matchers: z
    .array(z.object({ type: z.string(), field: z.string().optional(), value: z.string().optional() }))
    .nullish(),
  actions: z.array(z.object({ type: z.string(), value: z.array(z.string()).nullish() })).nullish(),
});
type ListedRule = z.infer<typeof ListedRule>;

const RuleEnvelope = z.object({
  success: z.boolean(),
  result: z.array(ListedRule).nullable().default([]),
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

/**
 * The DNS check for one subdomain on a zone, in the one shape that answers the question: a `result` object whose
 * `errors` lists the records Email Routing is still missing there. The endpoint has a second shape, a bare record list
 * or a null `result`, which says nothing about the subdomain, so it is read as no answer rather than a pass.
 */
const SubdomainCheck = z.object({
  result: z.object({ errors: z.array(z.unknown()), record: z.array(z.unknown()).nullish() }),
});

/** Whether Email Routing serves a domain, and why not when it does not. */
export type RoutingStatus = { enabled: true } | { enabled: false; reason: string };

/** What routing an address found: a rule made or changed, one already in place, or claims it will not override. */
export type AddressRouting =
  | { outcome: "created" | "updated" | "unchanged" }
  | { outcome: "conflict"; rules: string[] };

/** The one action a rule sending mail to `workerName` carries. */
function sendsTo(rule: ListedRule, workerName: string): boolean {
  return (rule.actions ?? []).some((action) => action.type === "worker" && (action.value ?? []).includes(workerName));
}

/** Whether `rule` claims exactly `address` — a literal `to` matcher, compared without case. */
function claims(rule: ListedRule, address: string): boolean {
  const wanted = address.toLowerCase();
  return (rule.matchers ?? []).some(
    (matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value?.toLowerCase() === wanted,
  );
}

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
   * Whether Email Routing serves `domain` on the zone that holds it. Read-only: enabling routing moves the domain's
   * MX, which stays the adopter's act. Both reads answer to Zone Settings Read.
   *
   * The zone's own Email Routing must be enabled, for the apex and a subdomain alike. A subdomain must also pass the
   * zone's DNS check for it, which lists the records routing still needs there: none missing is a subdomain routing
   * serves. A check that answers in any other shape is refused, never read as a pass.
   */
  async routingEnabledFor(options: { zoneId: string; zoneName: string; domain: string }): Promise<RoutingStatus> {
    const { zoneId, zoneName } = options;
    const domain = options.domain.toLowerCase();
    return cloudflareRequest("Email Routing read settings", async () => {
      const settings = await this.getClient().emailRouting.get({ zone_id: zoneId });
      if (settings.enabled !== true) {
        return { enabled: false, reason: `Email Routing is not enabled on the ${zoneName} zone.` };
      }
      if (domain === zoneName.toLowerCase()) return { enabled: true };
      const check = SubdomainCheck.safeParse(
        await this.getClient().emailRouting.dns.get({ zone_id: zoneId, subdomain: domain }),
      );
      if (!check.success) {
        return {
          enabled: false,
          reason: `Cloudflare's Email Routing DNS check for ${domain} did not say whether routing is set up for it.`,
        };
      }
      const missing = check.data.result.errors.length;
      if (missing > 0) {
        return {
          enabled: false,
          reason: `Email Routing is not enabled for ${domain}: Cloudflare lists ${missing} missing record${missing === 1 ? "" : "s"} for it.`,
        };
      }
      return { enabled: true };
    });
  }

  /**
   * Send mail addressed to exactly `address` to the Worker `workerName`. Only enabled rules claim mail, so only they are
   * weighed, and a disabled one is never re-enabled:
   *
   * - Every enabled rule claiming the address sends it to the Worker: `unchanged`, whatever the rules are named.
   * - One enabled rule claims it and sends it elsewhere: it is the sole claim, so it is taken over, keeping its name.
   * - More than one enabled rule claims it and any sends it elsewhere: `conflict`, naming them, and nothing changes.
   * - None does: a rule named `ruleName` is created, enabled.
   */
  async routeAddressToWorker(options: {
    zoneId: string;
    address: string;
    workerName: string;
    ruleName: string;
  }): Promise<AddressRouting> {
    const { zoneId, address, workerName, ruleName } = options;
    return cloudflareRequest("Email Routing route address", async () => {
      const enabled = (await this.#listRules(zoneId)).filter((rule) => rule.enabled === true && claims(rule, address));
      if (enabled.length > 0 && enabled.every((rule) => sendsTo(rule, workerName))) return { outcome: "unchanged" };
      if (enabled.length > 1) {
        return { outcome: "conflict", rules: enabled.map((rule) => rule.name || rule.id || "an unnamed rule") };
      }
      const matchers = [{ type: "literal" as const, field: "to" as const, value: address }];
      const actions = [{ type: "worker" as const, value: [workerName] }];
      const [sole] = enabled;
      if (sole?.id) {
        await this.getClient().emailRouting.rules.update(sole.id, {
          zone_id: zoneId,
          name: sole.name || ruleName,
          enabled: true,
          matchers,
          actions,
        });
        return { outcome: "updated" };
      }
      await this.getClient().emailRouting.rules.create({
        zone_id: zoneId,
        name: ruleName,
        enabled: true,
        matchers,
        actions,
      });
      return { outcome: "created" };
    });
  }

  /**
   * Remove every rule that claims exactly `address` and sends it to `workerName`. A rule for the address that sends it
   * anywhere else, and every rule for another address, is left. Idempotent: nothing matching is a no-op.
   */
  async unrouteAddressFromWorker(options: {
    zoneId: string;
    address: string;
    workerName: string;
  }): Promise<{ removed: number }> {
    const { zoneId, address, workerName } = options;
    return cloudflareRequest("Email Routing unroute address", async () => {
      const owned = (await this.#listRules(zoneId)).filter(
        (rule) => claims(rule, address) && sendsTo(rule, workerName),
      );
      let removed = 0;
      for (const rule of owned) {
        if (!rule.id) continue;
        await this.getClient().emailRouting.rules.delete(rule.id, { zone_id: zoneId });
        removed += 1;
      }
      return { removed };
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
  async #listRules(zoneId: string): Promise<ListedRule[]> {
    const rules: ListedRule[] = [];
    // The SDK's own base URL, so `CLOUDFLARE_BASE_URL` reaches this read as it reaches every typed call.
    const base = this.getClient().baseURL ?? "https://api.cloudflare.com/client/v4";

    for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
      const url = `${base}/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${RULES_PER_PAGE}`;
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
