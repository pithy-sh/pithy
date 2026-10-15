// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RefreshResult } from "@pithy-sh/cloudflare/src/oauth/client";
import { pithyOffline } from "../config";
import { boundProfileSync } from "./bindings";
import { ensureFreshSession, type Freshness } from "./refresh";

/** What dispatch hands {@link freshenBoundSession}. Every field defaults to the real process. */
export interface FreshenOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  refresh?: (args: { refreshToken: string }) => Promise<RefreshResult>;
}

/**
 * **Renew the session bound here before any command body runs — so no command is marked for it (#759).**
 *
 * A flag per command is a rule kept at the call sites, and `childEnv.ts` records how that goes: *held at
 * two of three*. The credential read is synchronous on purpose — 27 modules call into it — so a refresh,
 * which is a network call, cannot happen inside it. It happens here instead, once per invocation, and the
 * synchronous read then finds a fresh file. A token outside the margin costs no call at all, which is
 * almost every run of an hour-long token.
 *
 * **It never throws.** A session that cannot be renewed is refused by the credential read, with the sign-in
 * that fixes it, at the first command that needs Cloudflare — and a command that never touches Cloudflare
 * is never stopped over one. Offline renews nothing: `PITHY_OFFLINE` means nothing over the wire.
 */
export async function freshenBoundSession(options: FreshenOptions = {}): Promise<Freshness | null> {
  const env = options.env ?? process.env;
  if (pithyOffline(env)) return null;
  try {
    const bound = boundProfileSync(options.cwd ?? process.cwd(), { env });
    if (bound === null) return null;
    return await ensureFreshSession(bound.profile, { env, now: options.now, refresh: options.refresh });
  } catch {
    return null;
  }
}
