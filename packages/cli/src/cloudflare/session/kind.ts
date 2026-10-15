// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { StatePathOptions } from "../../notifier/state";
import { boundProfileSync } from "./bindings";
import { readSessionSync } from "./store";

/**
 * Whether `apiToken` is the access token of the session bound to `cwd` — a person signed in, rather
 * than a token somebody made (#759).
 *
 * **Derived, never asserted.** The audit actor follows from this, so it is answered by comparing the
 * token in hand with the session on disk, not by asking a caller to remember to say. An OAuth access token
 * carries neither `cfut_` nor `cfat_`, which is exactly why its spelling cannot be what decides.
 */
export function isBoundSessionToken(apiToken: string, options: StatePathOptions & { cwd?: string } = {}): boolean {
  const bound = boundProfileSync(options.cwd ?? process.cwd(), options);
  if (bound === null) return false;
  return readSessionSync(bound.profile, options)?.accessToken === apiToken;
}

/**
 * A token provider for a client built on the bound session's token — the **current** token on every call,
 * so a client constructed at the start of a long run never sends one an hourly renewal has replaced
 * (#759). `undefined` for any other token: an account token does not change under a client.
 */
export function sessionTokenProvider(
  apiToken: string,
  options: StatePathOptions & { cwd?: string } = {},
): (() => string) | undefined {
  const bound = boundProfileSync(options.cwd ?? process.cwd(), options);
  const started = bound === null ? null : readSessionSync(bound.profile, options);
  if (bound === null || started === null || started.accessToken !== apiToken) return undefined;
  // The profile and account this client was built for, fixed now. Renewals of *that* session are picked
  // up; a binding changed under a running process, or a profile signed in to another account, is not —
  // the client keeps its last token rather than send another account's with this one's id.
  const { profile } = bound;
  const accountId = started.accountId;
  let last = apiToken;
  return () => {
    const now = readSessionSync(profile, options);
    if (now !== null && now.accountId === accountId) last = now.accessToken;
    return last;
  };
}
