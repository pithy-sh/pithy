// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilitySettings, SettingsFinding } from "@pithy-sh/core/src/capability/settings";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SupportConfig } from "../config/config";

/**
 * Whether each address a reply is sent from can send, as `pithy doctor` asks it.
 *
 * A mailed reply is sent from the inbox the thread arrived at, so an inbox on a domain Email Service cannot send
 * from receives mail and cannot answer it: every reply fails at send with the domain named. Asked once per domain,
 * only while replies are on. Nothing here writes.
 */

/** The domain half of an address, lowercased, or `null` where it carries none. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/** Support's sending check, built from one composition's resolved config. */
export function supportSendingSettings(config: SupportConfig): CapabilitySettings {
  return {
    local: () => [],
    account: async (context) => {
      if (!config.reply.enabled) return [];
      // Every address a reply is sent from, under the setting that names it: the inbox a thread arrived at, and
      // `reply.replyToAddress` for a thread that arrived at none.
      const senders = [
        ...config.inboundAddresses.map((address) => ({ address, setting: "inboundAddresses" })),
        ...(config.reply.replyToAddress
          ? [{ address: config.reply.replyToAddress, setting: "reply.replyToAddress" }]
          : []),
      ];
      const byDomain = new Map<string, { setting: string; addresses: string[] }>();
      for (const { address, setting } of senders) {
        const domain = domainOf(address);
        if (domain === null) continue;
        const entry = byDomain.get(domain) ?? { setting, addresses: [] };
        if (!entry.addresses.includes(address)) entry.addresses.push(address);
        byDomain.set(domain, entry);
      }
      if (byDomain.size === 0) return [];
      const ask = context.account.sendingDomain;
      if (!ask) {
        throw new InternalError({
          message: "This doctor cannot ask whether a domain can send.",
          detail: "SettingsAccountReader.sendingDomain is absent.",
        });
      }
      const findings: SettingsFinding[] = [];
      for (const [domain, { setting, addresses }] of byDomain) {
        if (await ask.call(context.account, domain)) continue;
        findings.push({
          setting,
          environment: null,
          problem: `${domain} cannot send on Email Service, so a reply from ${addresses.join(", ")} fails.`,
          action: `Onboard ${domain} for sending in the Cloudflare dashboard under Email Service, then rerun doctor.`,
        });
      }
      return findings;
    },
  };
}
