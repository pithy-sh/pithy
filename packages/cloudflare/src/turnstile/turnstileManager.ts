// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import type { Cloudflare } from "cloudflare";
import type { Widget, WidgetListResponse } from "cloudflare/resources/turnstile/widgets";
import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRequest } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** The siteverify endpoint Turnstile tokens are validated against (server-side, not the SDK). */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Per-call SDK timeout + retry budget for widget management operations. */
const requestOptions: Cloudflare.RequestOptions = { timeout: 10000, maxRetries: 3 };

/**
 * The two widget modes Pithy provisions. `managed` is Cloudflare's *visible* managed widget (CF decides
 * whether to show interaction) — used where a challenge should be seen (a login page). `invisible` runs
 * silently — used where a form should not interrupt (a lead capture). One of each per domain, max.
 */
export type TurnstileWidgetMode = "managed" | "invisible";

/**
 * The server-side response from Turnstile's `/siteverify` endpoint. Pithy validates the raw JSON
 * through this object before trusting it — a humanity check is a security boundary (CLAUDE.md §HTTP:
 * Turnstile is composable middleware). `challenge_ts` is an ISO-8601 string on the wire, decoded to
 * a `Date` via the `JsonDate` codec.
 */
export const TurnstileVerification = z
  .object({
    success: z.boolean().describe("Whether the token passed the humanity challenge."),
    "error-codes": z.array(z.string()).default([]).describe("Machine-readable failure reasons; empty on success."),
    messages: z.array(z.string()).optional().describe("Optional human-readable notices from Cloudflare."),
    challenge_ts: JsonDate.optional().describe("When the challenge was solved (ISO-8601 on the wire, Date in JS)."),
    hostname: z.string().optional().describe("The hostname the challenge was solved on."),
    action: z.string().optional().describe("The customer-supplied action label bound to the token."),
    cdata: z.string().optional().describe("The customer-supplied context data bound to the token."),
  })
  .describe("Server-side Turnstile siteverify response from challenges.cloudflare.com.");
export type TurnstileVerification = z.output<typeof TurnstileVerification>;

/** Options for a server-side `verify` call. */
export interface TurnstileVerifyOptions {
  /** The end-user IP the token was issued to, for an extra integrity check. */
  remoteIp?: string;
  /** The expected action label, asserted by Cloudflare against the token. */
  action?: string;
}

/**
 * Out-of-Worker Turnstile access over the REST API: server-side token verification against
 * `/siteverify`, plus widget management (create/list/update/rotate/delete) via the SDK. Inside a
 * Worker the same siteverify call works over `fetch`; this manager is the CLI/CI/provisioning
 * counterpart, addressed by account.
 */
export class CloudflareTurnstileManager extends CloudflareManager {
  /**
   * Verify a Turnstile token server-side against `/siteverify`. The secret is the widget's secret
   * key (never the sitekey). The raw response is validated through `TurnstileVerification`; a
   * malformed body throws `cloudflare/invalid_response`, a network failure is wrapped as
   * `cloudflare/request_failed`.
   */
  async verify(token: string, secret: string, options?: TurnstileVerifyOptions): Promise<TurnstileVerification> {
    const body = new URLSearchParams({ secret, response: token });
    if (options?.remoteIp) body.set("remoteip", options.remoteIp);
    if (options?.action) body.set("action", options.action);

    const raw = await cloudflareRequest("Turnstile siteverify", async () => {
      const response = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) {
        throw new CloudflareInvalidResponseError({
          message: "Turnstile siteverify returned a non-OK status.",
          detail: `siteverify responded ${response.status} ${response.statusText}.`,
        });
      }
      return (await response.json()) as unknown;
    });

    const parsed = TurnstileVerification.safeParse(raw);
    if (!parsed.success) {
      throw new CloudflareInvalidResponseError({
        message: "Turnstile siteverify response had an unexpected shape.",
        detail: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /** Find a widget by name. Returns null when no widget matches; never throws on a missing match. */
  async getTurnstile(name: string): Promise<WidgetListResponse | null> {
    return cloudflareRequest(`Turnstile get widget '${name}'`, async () => {
      for await (const widget of this.getClient().turnstile.widgets.list({ account_id: this.accountId })) {
        if (widget.name === name) return widget;
      }
      return null;
    });
  }

  /**
   * Every widget claiming `domain`, matched case-insensitively (hostnames are). The sibling of
   * {@link getTurnstile}, keyed on the domain instead of the name — and **plural**, deliberately:
   * Cloudflare's widget names are not unique and a domain may legitimately appear on several widgets,
   * so returning one would hide the rest from a caller deciding whether the domain is free.
   *
   * Exact hostname equality only. Cloudflare treats a widget's domain as covering its subdomains, but
   * this is the input to a *refusal*, and a refusal inferred from a subdomain relationship would block
   * `app.example.com` because someone once made a widget for `example.com`.
   */
  async listTurnstilesByDomain(domain: string): Promise<WidgetListResponse[]> {
    const wanted = domain.toLowerCase();
    return cloudflareRequest(`Turnstile list widgets for '${domain}'`, async () => {
      const matches: WidgetListResponse[] = [];
      for await (const widget of this.getClient().turnstile.widgets.list({ account_id: this.accountId })) {
        if (widget.domains?.some((each) => each.toLowerCase() === wanted)) matches.push(widget);
      }
      return matches;
    });
  }

  /**
   * Create a widget for the given domains in the requested mode — `managed` (visible) or `invisible`
   * (silent). Defaults to `invisible` so existing callers keep their behavior.
   */
  async addTurnstile(name: string, domains: string[], mode: TurnstileWidgetMode = "invisible"): Promise<Widget> {
    return cloudflareRequest(`Turnstile create widget '${name}'`, () =>
      this.getClient().turnstile.widgets.create({ account_id: this.accountId, domains, mode, name }, requestOptions),
    );
  }

  /** Delete a widget by its sitekey. */
  async deleteTurnstile(siteKey: string): Promise<void> {
    await cloudflareRequest(`Turnstile delete widget '${siteKey}'`, () =>
      this.getClient().turnstile.widgets.delete(siteKey, { account_id: this.accountId }, requestOptions),
    );
  }

  /** Replace the allowed domains on an existing widget (kept in invisible mode). */
  async updateTurnstileDomains(siteKey: string, domains: string[], name: string): Promise<Widget> {
    return cloudflareRequest(`Turnstile update domains for '${siteKey}'`, () =>
      this.getClient().turnstile.widgets.update(
        siteKey,
        { account_id: this.accountId, domains, mode: "invisible", name },
        requestOptions,
      ),
    );
  }

  /** Rotate a widget's secret key, invalidating the old secret immediately. */
  async rotateTurnstile(siteKey: string): Promise<Widget> {
    return cloudflareRequest(`Turnstile rotate secret for '${siteKey}'`, () =>
      this.getClient().turnstile.widgets.rotateSecret(
        siteKey,
        { account_id: this.accountId, invalidate_immediately: true },
        requestOptions,
      ),
    );
  }

  getServiceType(): string {
    return "Cloudflare Turnstile";
  }

  /** Prove access by listing widgets. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().turnstile.widgets.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }
}
