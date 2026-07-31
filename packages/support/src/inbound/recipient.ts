// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "../mime/address";

/**
 * Which inbound messages belong to this capability.
 *
 * A Worker has exactly one `email()` entry, and `createEntrypoint` fans every message to **every**
 * capability that declares a handler. So a Worker running both `@pithy-sh/email` and this one sees
 * each bounce twice and each support request twice, and the discrimination is each handler's own
 * job. Email's handler filters by content — it acts only on DSNs and ARF reports. This one filters
 * by **address**, because a support request looks like ordinary mail and there is nothing in its
 * body to key on.
 *
 * ## The envelope recipient is the authority; the headers are not
 *
 * `ForwardableEmailMessage.to` is the SMTP envelope recipient — the address Cloudflare's own routing
 * rule matched to deliver here. It is the only recipient that was proved rather than asserted.
 *
 * The `To:` and `Cc:` headers are neither. Anyone can put `To: support@yourdomain.com` on a message
 * addressed elsewhere, and BCC means a legitimate message frequently does not name its real
 * recipient at all. Trusting them would let a stranger inject threads into an inbox they were never
 * routed to — so they are used only as a fallback for the one case where the envelope is unusable,
 * and never to override it.
 */

/** Whether an address is one of the configured inbox addresses. Both sides are already normalized. */
function claims(addresses: readonly string[], candidate: string | undefined): boolean {
  return candidate !== undefined && addresses.includes(candidate);
}

/**
 * Resolve which configured inbox a message landed on, or `undefined` when none of them did.
 *
 * The returned address is stored on the thread, so a Worker serving `support@` and `security@` can
 * keep the two apart in one table — and the value is the *configured* one rather than the envelope
 * string, so a thread's inbox is always something that appears in `pithy.config.ts`.
 */
export function resolveInbox(options: {
  /** The configured addresses, already normalized and lowercased. */
  inboundAddresses: readonly string[];
  /** The SMTP envelope recipient — `ForwardableEmailMessage.to`. The authority. */
  envelopeTo: string | undefined;
  /** `To`/`Cc`/`Delivered-To` from the parsed headers. Corroborating only. */
  headerRecipients: readonly string[];
}): string | undefined {
  const { inboundAddresses } = options;
  if (inboundAddresses.length === 0) return undefined;

  const envelope = normalizeAddress(options.envelopeTo);
  if (envelope !== undefined) {
    // The envelope was usable, so it decides — including deciding *against*. Falling through to the
    // headers here would be the whole vulnerability: a message routed to `hello@` could then claim
    // `support@` in a header it wrote itself.
    return claims(inboundAddresses, envelope) ? envelope : undefined;
  }

  // No usable envelope recipient. Rare, and always a sign of something hand-rolled upstream, but the
  // message did reach a Worker that only receives what a routing rule sent it — so the headers are
  // the best evidence left rather than an unvetted claim.
  for (const candidate of options.headerRecipients) {
    const normalized = normalizeAddress(candidate);
    if (claims(inboundAddresses, normalized)) return normalized;
  }
  return undefined;
}
