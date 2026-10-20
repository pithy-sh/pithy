// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { getOAuthState } from "better-auth/api";

/**
 * Whether a Microsoft sign-in's email is the signer's own — the one decision the Microsoft provider adds (#262).
 *
 * ## Why Microsoft needs a rule of its own
 *
 * Every other provider the kit serves can say which address it verified. Entra ID cannot. A work or
 * school ID token carries no `email_verified` claim, and its `email` is read from the directory's `mail`
 * attribute — which a tenant admin sets to any string, a stranger's address at a domain they do not own
 * included. Sign in, and the token asserts you are somebody else. That is the nOAuth takeover class, and
 * it is a property of Entra ID, not of an app's configuration. Microsoft's own claims reference says of
 * `email`: "This value isn't guaranteed to be correct, and is mutable over time - never use it for
 * authorization." So Microsoft stays out of `trustedProviders` permanently, and this decides the flag.
 *
 * ## The three ways an address is verified, and nothing else
 *
 * - **`xms_edov === true`** — "email domain owner verified", the optional claim Microsoft published as
 *   the nOAuth remediation. The tenant provably owns the address's domain, so it cannot be a stranger's.
 *   Off unless the app registration asks for it; `docs/microsoft-oauth.md` walks that step.
 * - **`tid` is the personal-accounts tenant.** A personal Microsoft account is in no directory, has no
 *   admin, and its address is the account itself, confirmed by Microsoft at sign-up. It never carries
 *   `xms_edov`, so it needs its own clause.
 * - **Linking from inside the account, to the account's own address.** The verify-to-link challenge's
 *   second half. Somebody refused above signs in by magic link — which proves the address — and connects
 *   Microsoft from inside. That Microsoft identity naming the very address the session holds is verified
 *   by the kit, not by Microsoft. A different address is not, and Better Auth's link branch refuses it.
 *
 * Anything else — the claim absent, `false`, `"true"`, `1` — is unverified. **Absence is never read as
 * verification**, and only the boolean `true` is. `email_verified` and `verified_primary_email` are read
 * by Better Auth's own default and deliberately not here: Entra does not issue the first for work
 * accounts, and the second is sourced from directory attributes this rule does not get to vouch for.
 *
 * `oid` and `tid` are immutable, so once an identity is linked it signs in on `oid` forever
 * (`./providerSignInGate.ts`, row 1) and none of this runs again for it.
 */

/**
 * The tenant id every personal Microsoft account signs in under.
 *
 * Source: https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference — the `tid`
 * row: "For sign-ins to the personal Microsoft account tenant (services like Xbox, Teams for Life, or
 * Outlook), the value is `9188040d-6c67-4c5b-b112-36a304b66dad`." The `iss` row names the same GUID.
 * Compared exactly: Microsoft issues it lowercase, and a token that spells it otherwise is not one of its.
 */
export const MICROSOFT_PERSONAL_ACCOUNTS_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** The part of a link-in-progress this rule reads: the signed-in account's own address. */
export interface LinkInProgress {
  /** The address on the account the session belongs to, as Better Auth's `/link-social` stored it. */
  readonly email: unknown;
}

/**
 * Decide the flag from the decoded ID token and, on a link, the account it is being linked to.
 *
 * Pure, so every hostile shape can be driven without a request. `profile` is the whole decoded ID token —
 * Better Auth hands `mapProfileToUser` the `decodeJwt` result itself (`@better-auth/core`
 * `social-providers/microsoft-entra-id.mjs`), so `xms_edov` and `tid` are in reach as claims, not as
 * fields somebody copied.
 */
export function microsoftEmailVerified(
  profile: Readonly<Record<string, unknown>>,
  link: LinkInProgress | null,
): boolean {
  if (profile.xms_edov === true) return true;
  if (profile.tid === MICROSOFT_PERSONAL_ACCOUNTS_TENANT_ID) return true;
  if (link === null) return false;
  const { email } = profile;
  if (typeof email !== "string" || email.length === 0) return false;
  if (typeof link.email !== "string" || link.email.length === 0) return false;
  return email.toLowerCase() === link.email.toLowerCase();
}

/**
 * The link this callback completes, or `null` when it is a sign-in.
 *
 * `link` is written by Better Auth's `/link-social` alone: `generateState` spreads the caller's
 * `additionalData` first and assigns `link` last, so a sign-in overwrites any injected one
 * (`./providerSignInGate.ts` records it, and plants against it).
 *
 * **`getOAuthState()` throws where no request state was established**, and here the throw is caught on
 * purpose, unlike the gate's. The gate's safe direction is a loud failure; this one's is *unverified*,
 * and that is exactly what a missing link means.
 */
async function linkInProgress(): Promise<LinkInProgress | null> {
  try {
    const state = await getOAuthState();
    const link: unknown = state?.link;
    if (typeof link !== "object" || link === null || !("email" in link)) return null;
    return { email: link.email };
  } catch {
    return null;
  }
}

/**
 * The Microsoft block's `mapProfileToUser`: the rule, applied to this callback.
 *
 * **It always states the flag.** Better Auth computes its own default first and spreads this over it, so
 * a mapper that omitted the key on the unverified path would leave that default — read off claims a
 * tenant can influence — standing.
 */
export async function microsoftProfileToUser(
  profile: Readonly<Record<string, unknown>>,
): Promise<{ emailVerified: boolean }> {
  return { emailVerified: microsoftEmailVerified(profile, await linkInProgress()) };
}
