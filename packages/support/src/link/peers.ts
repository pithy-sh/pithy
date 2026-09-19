// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthPeer } from "@pithy-sh/auth/src/peer";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { PaymentsPeer } from "@pithy-sh/payments/src/peer";
import type { SenderPeers } from "./sender";

/**
 * How `support()`'s `compose` hook finds the sender link's optional peers (#645). Its own module so
 * `sender.ts` stays free of the capability contract, which a browser program has no use for.
 */

/** The named capability's peer surface, when it is composed and carries one. */
function surface<T>(capabilities: readonly Capability[], name: string, key: string): T | undefined {
  const found = capabilities.find((capability) => capability.name === name && key in capability);
  return found ? ((found as unknown as Record<string, unknown>)[key] as T) : undefined;
}

/** The peers a composition holds — what `support()`'s `compose` hook records. */
export function senderPeers(capabilities: readonly Capability[]): SenderPeers {
  const auth = surface<AuthPeer>(capabilities, "auth", "authPeer");
  const payments = surface<PaymentsPeer>(capabilities, "payments", "paymentsPeer");
  return { ...(auth ? { auth } : {}), ...(payments ? { payments } : {}) };
}
