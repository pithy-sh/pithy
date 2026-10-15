// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { missingScopes } from "@pithy-sh/cloudflare/src/oauth/scopes";
import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import type { StatePathOptions } from "../../notifier/state";
import { boundProfileSync } from "./bindings";
import { readSessionSync } from "./store";

/** What {@link requireSessionConsent} reads: where, with which token, and what the project now needs. */
export interface ConsentCheck extends StatePathOptions {
  /** The directory the command runs in. */
  cwd: string;
  /** The token the command is about to use. Only the bound session's own token is checked. */
  apiToken: string;
  /** The scopes the project derives today — `projectSessionScopes`. */
  needed: readonly string[];
}

/**
 * **Composing a capability asks for consent, rather than failing at the next mint (#759).**
 *
 * A session is scoped to what the project composed when it signed in. Compose a capability that carries
 * a new permission and the next `token mint` would be refused by Cloudflare's delegation rule, in
 * Cloudflare's words, about a permission group the operator never chose. So the mint checks first: the
 * scopes the project derives now, against the scopes the session was granted, and a gap is refused with
 * the sign-in that approves it. The same shape as `rotate` being required when permissions change — and
 * a feature: widening what Pithy may do against an account becomes something a person approves.
 *
 * A token that is not the bound session's is not checked: an account token carries its own policies.
 */
export function requireSessionConsent(check: ConsentCheck): void {
  const bound = boundProfileSync(check.cwd, check);
  const session = bound === null ? null : readSessionSync(bound.profile, check);
  if (session === null || session.accessToken !== check.apiToken) return;
  const missing = missingScopes(check.needed, session.scope);
  if (missing.length === 0) return;
  throw new PreconditionFailedError({
    message: `This project now needs permissions the session for profile ${session.profile} was not granted: ${missing.join(", ")}.`,
    action: `Run ${pithyCommand("cloudflare connect", { flags: { "--profile": session.profile } })} to approve them, then run this again.`,
    detail: `granted ${session.scope}`,
  });
}
