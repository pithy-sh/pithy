// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { CloudflareRequestError } from "../client/errors";
import type { IntegrationCreds } from "./harness";

/**
 * A zone's Email Routing rules, read whole.
 *
 * `CloudflareEmailRoutingManager` reads the same endpoint and keeps only `id` and `name`, because
 * matching by name and deleting by id is all provisioning needs. Two callers here need more.
 *
 * **A live test has to see what Cloudflare stored, not what we sent.** #47's open question is whether
 * the `matchers`/`actions` shape `ensureWorkerRoute` posts still matches the current API — and a test
 * that asserts on its own request argument answers nothing. So the rule comes back in full and the
 * assertions are on the stored copy.
 *
 * **The reaper needs names it can hand back to `removeWorkerRoute`.** A run that dies between creating
 * a rule and tearing it down leaves live mail routing to a Worker that is about to be deleted, which is
 * the one piece of debris in this repo that changes what happens to somebody's mail rather than costing
 * a few cents.
 *
 * ## Two documented traps, both live here so nobody has to rediscover them
 *
 * **Every zone has a catch-all rule whether or not anything is configured** — no name, priority
 * `2147483647`, `matchers: [{ type: "all" }]`. A rule count of 1 means nothing. {@link namedRules}
 * drops it, so a caller counting *our* rules counts ours.
 *
 * **`result_info` on this endpoint carries no `total_pages`** on a single-page zone. The paging loop
 * therefore stops on a short page, exactly as the manager's does.
 */

/** Rules per page. Cloudflare's maximum, so the common zone is answered in one request. */
const RULES_PER_PAGE = 50;

/** A hard stop on the page loop, so a malformed `result_info` cannot spin forever. */
const MAX_RULE_PAGES = 100;

/** One matcher on a routing rule: which mail the rule claims. */
export const EmailRoutingMatcher = z
  .object({
    type: z.string().describe("`literal` for one address, `all` for the zone's catch-all."),
    field: z.string().optional().describe("The header the literal matches on — `to` for every rule Pithy writes."),
    value: z.string().optional().describe("The address a `literal` matcher claims. Absent on a catch-all."),
  })
  .describe("One matcher on an Email Routing rule.");

/** One action on a routing rule: what happens to the mail it claimed. */
export const EmailRoutingAction = z
  .object({
    type: z.string().describe("`worker` for a Worker delivery, `drop` for the default catch-all, `forward` otherwise."),
    value: z.array(z.string()).default([]).describe("The action's targets — a single Worker script name for `worker`."),
  })
  .describe("One action on an Email Routing rule.");

/** One Email Routing rule, as the zone stores it. */
export const EmailRoutingRule = z
  .object({
    id: z.string().describe("Cloudflare's id for the rule — what a delete addresses."),
    name: z.string().default("").describe("The rule's name. Empty on the default catch-all every zone carries."),
    enabled: z
      .boolean()
      .default(false)
      .describe("Whether the rule is live. The catch-all's flag doubles as the zone's."),
    priority: z.number().default(0).describe("Match order, lowest first. The catch-all sits at 2147483647."),
    matchers: z.array(EmailRoutingMatcher).default([]).describe("Which mail this rule claims."),
    actions: z.array(EmailRoutingAction).default([]).describe("What happens to the mail this rule claimed."),
  })
  .describe("One Email Routing rule on a zone, read back in full.");

/** One Email Routing rule, as the zone stores it. */
export type EmailRoutingRule = z.output<typeof EmailRoutingRule>;

/** The list envelope, validated because a response read is a boundary. */
const RuleListEnvelope = z
  .object({
    success: z.boolean().describe("Cloudflare's own verdict on the request."),
    result: z.array(EmailRoutingRule).nullable().default([]).describe("This page of rules. Null on a failed call."),
    result_info: z
      .object({
        page: z.number().optional().describe("The page just returned."),
        total_pages: z.number().optional().describe("Total pages, when Cloudflare states one. Often absent."),
      })
      .nullish()
      .describe("The paging block, when the response carries one."),
  })
  .describe("A page of a zone's Email Routing rules.");

/** Every Email Routing rule on a zone, paged to exhaustion. */
export async function listEmailRoutingRules(creds: IntegrationCreds, zoneId: string): Promise<EmailRoutingRule[]> {
  const rules: EmailRoutingRule[] = [];

  for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${RULES_PER_PAGE}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${creds.apiToken}` } });
    if (!response.ok) {
      throw new CloudflareRequestError({
        message: "Could not read the zone's Email Routing rules.",
        action: "Check the token carries Email Routing Rules: Read on this zone.",
        detail: `Email Routing rule list returned ${response.status}.`,
      });
    }

    const envelope = RuleListEnvelope.parse(await response.json());
    const batch = envelope.result ?? [];
    rules.push(...batch);

    const totalPages = envelope.result_info?.total_pages;
    if (totalPages !== undefined ? page >= totalPages : batch.length < RULES_PER_PAGE) break;
  }

  return rules;
}

/**
 * The rules somebody named — the zone's own rules, without the unnamed catch-all Cloudflare puts on
 * every zone configured or not.
 */
export function namedRules(rules: readonly EmailRoutingRule[]): EmailRoutingRule[] {
  return rules.filter((rule) => rule.name !== "");
}
