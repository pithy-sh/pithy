// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseAddress } from "@pithy-sh/core/src/address/address";
import { getDomain } from "tldts";

/**
 * Whether a message's `From:` header is something we are entitled to believe.
 *
 * ## Why this exists
 *
 * `From:` is an unauthenticated claim. Anyone can send mail saying `From: ada@example.com`, and for
 * every domain that publishes DMARC `p=none` — which is most small domains and plenty of large ones
 * — a receiving MTA will deliver it rather than reject it.
 *
 * That claim is the join key for the customer link: it resolves to a `pithy_auth_users` row and
 * pulls that account's name, entitlements, and itemised purchase history into a support console,
 * where a human reads it and acts. Rendering an attacker's thread decorated with a real customer's
 * billing history is the standard opening move of support-driven account takeover, and this
 * capability's own `account_access` and `privacy_request` categories route exactly those messages to
 * an operator already primed to act on them.
 *
 * The recipient side of this package gets the equivalent question right and says so at length: the
 * SMTP envelope is authority, headers are not. This is that same rule applied to the sender.
 *
 * ## What counts as authenticated
 *
 * DMARC is the only verdict that asserts what we actually need — that the **`From:` domain** is
 * aligned with something that passed. `spf=pass` alone says the *envelope* sender's domain passed,
 * which is a different domain and is exactly the gap DMARC exists to close, so it counts only when
 * the envelope sender aligns with the header From. `dkim=pass` alone has the same alignment gap.
 *
 * Absence is not a pass. A message with no `Authentication-Results` at all is unauthenticated, which
 * is the right answer for mail that reached us through something that never checked.
 */

/** What is known about a sender's claimed identity. */
export interface SenderAuthenticity {
  /** Whether the `From:` header may be treated as the real sender. */
  authenticated: boolean;
  /** How it was established, for the log and for a dashboard to explain itself. `none` when it was not. */
  method: "dmarc" | "spf-aligned" | "none";
}

/** The domain half of an address, lowercased. */
function domainOf(address: string | undefined): string | undefined {
  const normalized = parseAddress(address);
  const at = normalized?.lastIndexOf("@") ?? -1;
  return normalized && at > 0 ? normalized.slice(at + 1) : undefined;
}

/**
 * Whether two domains are aligned in the relaxed sense DMARC uses — the same Organizational Domain.
 *
 * **This is a public-suffix lookup, not label arithmetic, because RFC 7489 §3.2 defines relaxed
 * alignment in terms of the Organizational Domain and that term is defined by the public suffix
 * list.** An earlier version counted labels and required a shared parent of at least two, which is a
 * decent approximation and wrong in exactly the way approximations of security boundaries are wrong:
 * `co.uk` has two labels, so it "aligned" with `bbc.co.uk`. Implementing the actual algorithm removes
 * the whole class rather than the instance somebody happened to notice.
 *
 * `allowPrivateDomains` is on. Without it `a.github.io` and `b.github.io` both reduce to `github.io`
 * and two unrelated people's sites align with each other; the private section of the list is what
 * knows that `github.io` is a boundary. Stricter is the right direction for a check that gates
 * whether a stranger's mail gets decorated with a real customer's purchase history.
 *
 * A domain that has no Organizational Domain at all — a bare public suffix like `co.uk`, an IP
 * literal, `localhost` — returns `null` from `getDomain` and therefore aligns with nothing, which is
 * the correct answer rather than a special case.
 */
export function domainsAlign(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const organizational = getDomain(a, { allowPrivateDomains: true });
  return organizational !== null && organizational === getDomain(b, { allowPrivateDomains: true });
}

/**
 * Decide whether the `From:` header is believable.
 *
 * Takes the parsed verdicts and both addresses rather than the whole message, so the decision is a
 * pure function of four values and is testable without a MIME fixture.
 */
export function senderAuthenticity(options: {
  /** The `Authentication-Results` verdicts, keyed by method. */
  authResults: Record<string, string>;
  /** The address in the `From:` header, normalized. */
  fromAddress: string;
  /** The SMTP envelope sender — what SPF was actually evaluated against. */
  envelopeFrom: string | undefined;
  /**
   * Whether the adopter has attested that the header is worth reading at all.
   *
   * **Default off, and this is the load-bearing gate.** Under Cloudflare Email Routing a Worker is
   * not reliably given the MTA's own `Authentication-Results`, and a header the *sender* wrote is
   * indistinguishable from one an MTA wrote once the MTA's copy is absent — so reading it by default
   * would mean believing whatever the attacker typed. Everything below is a verdict about a value
   * that only means something once somebody has said their pipeline produces it honestly.
   */
  trusted: boolean;
}): SenderAuthenticity {
  if (!options.trusted) return { authenticated: false, method: "none" };

  if (options.authResults.dmarc === "pass") return { authenticated: true, method: "dmarc" };

  // SPF passed, but on the envelope sender's domain. It only tells us anything about the `From:`
  // header when the two align — which is the check DMARC would have done for us.
  if (options.authResults.spf === "pass") {
    const envelope = domainOf(options.envelopeFrom);
    const header = domainOf(options.fromAddress);
    if (domainsAlign(envelope, header)) return { authenticated: true, method: "spf-aligned" };
  }

  return { authenticated: false, method: "none" };
}
