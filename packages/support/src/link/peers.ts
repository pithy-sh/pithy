// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthPeer } from "@pithy-sh/auth/src/peer";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { PaymentsPeer } from "@pithy-sh/payments/src/peer";
import type { SupportConfig } from "../config/config";
import type { SenderPeers } from "./sender";

/**
 * How `support()`'s `compose` hook finds the sender link's optional peers (#645). Its own module so
 * `sender.ts` stays free of the capability contract, which a browser program has no use for.
 *
 * **Nothing degrades silently (#645 review).** A composed auth or payments released before its surface is
 * refused, whatever the config: read as absent, a project that plainly has accounts stopped linking every sender,
 * and one that plainly sells stopped showing an operator what anybody bought. The in-app channel, on by default,
 * is refused without auth in this Worker: every submission is keyed to the account a session proves, and the
 * account is read through auth, so the channel could not accept one report. Turning it off is the adopter's
 * statement that this Worker is a mail inbox, and then an absent auth or payments proceeds — see
 * {@link senderPeers}.
 */

/** One optional peer, as `senderPeers` looks for it. */
interface Wanted {
  readonly name: string;
  readonly pkg: string;
  readonly config: string;
  readonly key: string;
  readonly probe: string;
  readonly wants: string;
}

/**
 * The named kit capability's peer surface: `undefined` when it is not composed, or a refusal when it is composed
 * from a release too old to carry one. Recognized by the config field it has always carried, not by the surface,
 * because a pre-#645 release has the one and not the other.
 */
function surface<T>(capabilities: readonly Capability[], wanted: Wanted): T | undefined {
  const found = capabilities.find((capability) => capability.name === wanted.name && wanted.config in capability);
  if (found === undefined) return undefined;
  const value = (found as unknown as Record<string, Record<string, unknown> | undefined>)[wanted.key];
  if (typeof value?.[wanted.probe] !== "function") {
    throw new ValidationError({
      message: `Support ${wanted.wants} through ${wanted.pkg}, and the composed one is too old to be reached.`,
      action: `Upgrade ${wanted.pkg} to the version this @pithy-sh/support peers.`,
      detail: `The composed ${wanted.name} capability carries no \`${wanted.key}\`. It was released before optional peers arrived through the composition (#645).`,
    });
  }
  return value as T;
}

/**
 * The peers a composition holds — what `support()`'s `compose` hook records — refusing one this Worker's config
 * needs and cannot reach.
 *
 * With the in-app channel off, auth and payments may both be absent. A sender is then never linked to an account
 * and a thread shows no purchases, which is exactly what a project with no accounts and no store has to show.
 */
export function senderPeers(capabilities: readonly Capability[], config: SupportConfig): SenderPeers {
  const auth = surface<AuthPeer>(capabilities, {
    name: "auth",
    pkg: "@pithy-sh/auth",
    config: "authConfig",
    key: "authPeer",
    probe: "authDatabase",
    wants: "links a sender to an account",
  });
  const payments = surface<PaymentsPeer>(capabilities, {
    name: "payments",
    pkg: "@pithy-sh/payments",
    config: "paymentsConfig",
    key: "paymentsPeer",
    probe: "resolveEntitlements",
    wants: "shows what a sender bought",
  });
  if (config.submission.enabled && auth === undefined) {
    throw new ValidationError({
      message: "The in-app support channel is on, and no auth is composed in this Worker.",
      action:
        "Add `auth(...)` to this Worker's capabilities in pithy.config.ts — the one that composes support — or set `submission: { enabled: false }` for a mail-only inbox.",
      detail:
        "`submission.enabled` defaults to true. A submission is keyed to the account its session proves, read through @pithy-sh/auth, so without auth in this Worker the channel refuses every report, and no sender on the mail path is ever linked to an account.",
    });
  }
  return { ...(auth ? { auth } : {}), ...(payments ? { payments } : {}) };
}
