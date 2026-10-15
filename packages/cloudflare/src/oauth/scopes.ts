// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { oauthScopesFor } from "../tokens/permissions";

/**
 * The scopes every session asks for, whatever the project composes (#759).
 *
 * - `user-details.read` — `GET /user`, which is what turns an audit row's actor from a token's name into
 *   the person who signed in.
 * - `offline_access` — the only way Cloudflare issues a refresh token. Without it a session dies at the
 *   hour and every command after it opens a browser (measured 2026-10-15).
 * - `account-api-tokens.write` — the mint. A session mints `ci-system` and every worker-consumer token
 *   the project declares, so the hand-made bootstrap token stops being a setup step.
 * - `account-settings.read` — `GET /accounts`, so the account is discovered rather than stored. On its own
 *   it lists the account; `d1.write` alone listed nothing (both measured 2026-10-15), so discovery must not
 *   lean on whichever other scope a project happens to request.
 * - `zone.read` — `pithy init` and `pithy worker add` offer the account's real zones, and `init` asks
 *   before there is a project whose capabilities could say so. Read-only, as {@link OAUTH_SCOPES} says of it.
 *
 * Everything else comes from the project's own token permissions, through {@link sessionScopes}.
 */
export const SESSION_BASE_SCOPES = [
  "user-details.read",
  "offline_access",
  "account-api-tokens.write",
  "account-settings.read",
  "zone.read",
] as const;

/**
 * The scopes Cloudflare's consent screen lists under **"Sensitive scopes"**, switched off, by the name it
 * shows them under.
 *
 * **Approving with one switched off does not grant the rest.** The dashboard answers *"We could not
 * complete the authorization. Please check your network connection and try again."* and no callback
 * ever arrives (measured 2026-10-15). So `connect` names these before it opens the browser, and its
 * timeout names them as the likeliest cause.
 *
 * **The list is ours to keep, because Cloudflare's is not published.** `GET /oauth/scopes` carries an
 * id, a name, a category and nothing that marks a scope sensitive; only the consent screen says. Add to
 * it when a consent screen shows another.
 */
export const SENSITIVE_SCOPES: Readonly<Record<string, string>> = {
  "account-api-tokens.write": "Account API Tokens Write",
};

/**
 * The scopes a session needs to act for a project, and to mint every token it declares: the base, then
 * the scope of each permission key, de-duped in first-seen order.
 *
 * **Derived, never listed.** Cloudflare's delegation rule binds the session as it binds a token — a mint
 * whose groups the session does not hold is refused — so the request is exactly the union of what the
 * project's tokens carry. A capability the project does not compose contributes nothing to it, and so
 * nothing to the consent screen the adopter reads.
 */
export function sessionScopes(permissionKeys: readonly string[]): string[] {
  const scopes: string[] = [...SESSION_BASE_SCOPES];
  for (const scope of oauthScopesFor(permissionKeys)) {
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/**
 * The requested scopes a grant does not carry, in request order.
 *
 * `granted` is the token endpoint's `scope`: one space-separated string. Today Cloudflare fails rather
 * than grant a subset, so this should always be empty; it is checked because that is Cloudflare's
 * behavior to change, and a session missing `account-api-tokens.write` would fail at the first mint.
 */
export function missingScopes(requested: readonly string[], granted: string): string[] {
  const held = new Set(granted.split(/\s+/).filter(Boolean));
  return requested.filter((scope) => !held.has(scope));
}

/** One sensitive scope a request carries, by its id and the name the consent screen shows. */
export interface SensitiveScope {
  /** The catalog id: `account-api-tokens.write`. */
  id: string;
  /** What the consent screen calls it: "Account API Tokens Write". */
  name: string;
}

/** The sensitive scopes in a request, in request order. See {@link SENSITIVE_SCOPES}. */
export function sensitiveScopesIn(scopes: readonly string[]): SensitiveScope[] {
  return scopes.flatMap((id) => {
    const name = SENSITIVE_SCOPES[id];
    return name === undefined ? [] : [{ id, name }];
  });
}
