// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * One answer for every refusal the user table decided (#625).
 *
 * ## The defect
 *
 * A refused social sign-in redirects to the adopter's `errorCallbackURL` with `?error=<code>`, and two
 * of those codes are decided by **whether a row exists at the address the provider handed over**:
 *
 * | Code | Emitted only when |
 * | --- | --- |
 * | `account_not_linked` | a user row **did** match (`better-auth/dist/oauth2/link-account.mjs:86`) |
 * | `signup_disabled` | **no** row matched (`:202`) |
 *
 * Both leave through one line — `redirectOnError(result.error.split(" ").join("_"))`,
 * `dist/api/routes/callback.mjs:245` — so from outside the Worker they are one question with two
 * answers. Press the provider button, read the `Location` header, repeat: an account-enumeration oracle
 * needing one GitHub account, no account on the target, and no page render. It works against the
 * configuration the kit's own security guidance recommends (`allowSignUp: false`, #554), so the
 * projects that followed the advice are the exposed ones.
 *
 * ## Two more producers, found by asking the question instead of reading the issue
 *
 * The issue named two codes and cleared `EMAIL_NOT_VERIFIED` as "the provider's own state". The *text*
 * is the provider's state; its **reachability** is not. The kit throws it from `user.create.before`
 * (`instance/auth.ts`), and creating a user is something the callback only ever attempts when no row
 * matched. So with sign-up permitted — the default — the pair is `account_not_linked` against
 * `EMAIL_NOT_VERIFIED`, and it is the same oracle wearing a different name. Measured, not reasoned:
 * `providerRefusal.workers.test.ts` drives both sign-up policies. `unable_to_create_user` sits on the
 * same side of the same branch and joins them.
 *
 * That is why this module is a **roster with a verdict per code** rather than a pair of strings. The
 * question a code has to answer is not "is this sentence sensitive" but "could the Worker have produced
 * it without looking in its own user table".
 *
 * ## Why this is the kit's job and not an adopter's
 *
 * An adopter can only put middleware in front of the same Response and rewrite the header — collapsing
 * the code *and losing the reason with it*. Held here, at the one place the capability hands a Better
 * Auth response back, both halves survive: the browser gets one code, and {@link CollapsedRefusal}'s
 * `reason` says which refusal it really was, for `handleBetterAuth` to put on the audit trail.
 * Composing `auth` is the whole of what an adopter does to get it, and there is no option to forget.
 */

/**
 * The one code a refused social sign-in redirects with, whatever the Worker actually found.
 *
 * Named for the outcome the reader may know — the provider did not sign them in — rather than the
 * reason they may not. **Do not make this more helpful.** Every sentence that distinguishes "you have
 * no account here" from "you have one and this provider is not attached to it" is the oracle back, and
 * the adopter screen reading this code is where the (identical, deliberately unspecific) copy lives.
 */
export const NEUTRAL_PROVIDER_REFUSAL = "provider_sign_in_refused";

/** Whether a code may travel to the browser, and the reason that verdict was reached. */
interface RefusalVerdict {
  /**
   * `true` when the code is reachable on only one side of "did a row match", and must therefore
   * collapse. `false` when nothing about it depends on this Worker's user table.
   */
  readonly collapse: boolean;
  /** Why. Written for the next person to be asked to make an error message more useful. */
  readonly why: string;
}

/**
 * Every `error` code reachable on the social callback's redirect, with its verdict.
 *
 * **Completeness is gated, which is what keeps this from being a list of forbidden strings.**
 * `providerRefusal.test.ts` reads Better Auth's own `OAUTH_CALLBACK_ERROR_CODES` and scans the
 * `result.error` literals out of `link-account.mjs`, and requires every one to appear here. A dependency
 * bump that adds a code turns that red, and somebody writes a verdict for it. So the roster records a
 * *review*, and the review cannot silently fall behind the thing it reviews.
 *
 * **Off-roster codes travel, and that is a decision rather than an oversight.** Collapsing the unknown
 * would be the safer default for our own codes and the wrong one overall: `callback.mjs:85` forwards the
 * provider's own `error` parameter verbatim, and RFC 6749 §4.1.2.1 leaves that an open set. A reader who
 * pressed Cancel at GitHub would get `provider_sign_in_refused` — "we could not sign you in" for an act
 * they know perfectly well they performed — and every adopter screen that reads `access_denied` would go
 * quiet. Nothing in that set can be decided by our user table, because it is decided before this Worker
 * looks at anything. The completeness gate is what covers the half that can.
 */
const PROVIDER_REFUSAL_VERDICTS: Readonly<Record<string, RefusalVerdict>> = {
  // ── Decided by the user table. These are the defect. ───────────────────────────────────────────
  account_not_linked: {
    collapse: true,
    why: "link-account.mjs:86 — returned only inside `if (dbUser)`, so it is literally the statement that a row matched.",
  },
  signup_disabled: {
    collapse: true,
    why: "link-account.mjs:202 — the `else` of that same branch, so it is literally the statement that none did.",
  },
  EMAIL_NOT_VERIFIED: {
    collapse: true,
    why: "The kit's own `user.create.before` hook (instance/auth.ts). A user is only ever created when no row matched, so this code cannot be observed against an address that has an account — which makes it the other half of `account_not_linked` whenever sign-up is permitted. The sentence is about the provider; the fact that you are reading it is about us.",
  },
  unable_to_create_user: {
    collapse: true,
    why: "link-account.mjs:254 — the create path only, so it sits on the no-row side exactly as `signup_disabled` does. A fault rather than a refusal, and still an answer to the question being asked.",
  },

  // ── The caller's own request, or the provider's. Nothing to do with our rows. ──────────────────
  no_code: {
    collapse: false,
    why: "The provider came back without a code. The shape of the request itself, settled before any lookup.",
  },
  invalid_code: {
    collapse: false,
    why: "The code would not exchange at the provider's token endpoint. Settled before any lookup.",
  },
  invalid_callback_request: {
    collapse: false,
    why: "callback.mjs:55 — the callback's own query or body would not parse. Raised before `parseState`, so nothing had been read from anywhere yet.",
  },
  oauth_provider_not_found: {
    collapse: false,
    why: "This deployment does not serve that provider. A fact about the configuration, and `providers.ts` already draws the one distinction that matters here.",
  },
  issuer_missing: {
    collapse: false,
    why: "The provider's own response did not name an issuer. Nothing was looked up.",
  },
  issuer_mismatch: {
    collapse: false,
    why: "The provider's response named the wrong issuer. Nothing was looked up.",
  },
  nonce_binding_missing: {
    collapse: false,
    why: "The request's own nonce binding. Checked against the state, never against a user row.",
  },
  unable_to_get_user_info: {
    collapse: false,
    why: "The provider would not say who this is. Decided before any lookup — and the kit's resolver fails closed to exactly here, so collapsing it would render a GitHub outage as a refusal (githubUserInfo.ts).",
  },
  no_callback_url: {
    collapse: false,
    why: "No `callbackURL` was carried in the state. The adopter's own configuration, and the same answer for everybody.",
  },
  email_not_found: {
    collapse: false,
    why: "The provider returned no address at all. Its state, and reached before this Worker looks anything up.",
  },
  email_not_verified: {
    collapse: false,
    why: "Better Auth's lower-case code, from `requireEmailVerification` (link-account.mjs:263) — which the kit does not set. Reachable for a registering and a returning user alike, so it names no row either way. Not to be confused with the kit's upper-case `EMAIL_NOT_VERIFIED` above; the two are different strings from different places and only one of them is the oracle.",
  },
  unable_to_create_session: {
    collapse: false,
    why: "link-account.mjs:269 — after the user is resolved, so it is reached from both sides of the branch equally.",
  },
  state_not_found: {
    collapse: false,
    why: "The request carried no state to parse. Raised at state.mjs:90, before any lookup.",
  },
  state_mismatch: {
    collapse: false,
    why: "The request's own state did not match what was stored. Nothing about a user was read to decide it.",
  },
  state_security_mismatch: {
    collapse: false,
    why: "The same fact as `state_mismatch`, which is what `oauth2/state.mjs` remaps it to before it reaches a browser. Rostered under its own name because the remap is the dependency's internal detail, not a promise.",
  },
  state_invalid: {
    collapse: false,
    why: "The state would not decrypt or parse. The request's own credential, and nothing else.",
  },
  state_generation_error: {
    collapse: false,
    why: "Minting the state failed on the way out. A fault on this Worker's own side, raised before there is a callback to answer, let alone a row to read.",
  },
  internal_server_error: {
    collapse: false,
    why: "A fault, raised in place of the lookup it would otherwise have reported on — so it says a lookup did not finish, never what one found.",
  },

  // ── The link flow. The caller already holds a session for the account in question. ─────────────
  unable_to_link_account: {
    collapse: false,
    why: "callback.mjs:173/198, inside `if (link)` — reachable only on `/link-social`, where the caller is signed in as the user being changed. Telling somebody about their own account is not enumeration.",
  },
  email_does_not_match: {
    collapse: false,
    why: "The link flow, and the address compared against is the signed-in caller's own. The caller's account, as above.",
  },
  account_already_linked_to_different_user: {
    collapse: false,
    why: "The link flow. The caller's own account, as above — and the other user is named by nothing here.",
  },
  unable_to_update_account: {
    collapse: false,
    why: "link-account.mjs:172, inside `if (linkedAccount)` — reaching it requires an account already linked to this very user, which is proof of ownership rather than a matched row.",
  },
  INVALID_PROFILE_FIELD: {
    collapse: false,
    why: "The kit's `user.update.before` hook. On this path `updateUser` runs only inside `if (linkedAccount)` (link-account.mjs:186), so reaching it requires an account already linked to the caller's own user — provable ownership, not a matched row.",
  },
};

/** The codes this module refuses to let out. Derived from the roster, so the two cannot disagree. */
export const PROVIDER_REFUSAL_CODES: readonly string[] = Object.entries(PROVIDER_REFUSAL_VERDICTS)
  .filter(([, verdict]) => verdict.collapse)
  .map(([code]) => code);

/** The roster, for the completeness gate. Not part of the package's surface. */
export const PROVIDER_REFUSAL_ROSTER: Readonly<Record<string, RefusalVerdict>> = PROVIDER_REFUSAL_VERDICTS;

/** A refusal that was collapsed: what now goes on the wire, and what really happened. */
export interface CollapsedRefusal {
  /** The redirect with the neutral code in place of the revealing one. */
  readonly response: Response;
  /** The code that was taken off the wire — for the audit trail, and for nothing else. */
  readonly reason: string;
}

/**
 * Collapse a social-callback refusal that our own user table decided, or answer `undefined`.
 *
 * `undefined` for every response that is not a redirect off the callback path carrying a rostered,
 * collapsing `error` — which is nearly all of them, including every successful sign-in, since a
 * completed callback redirects to `callbackURL` with no `error` at all.
 *
 * **`error_description` goes with it.** Nothing sets one for these today, and a description is a whole
 * sentence written by whoever raises the code next — so it is dropped rather than carried past a header
 * that was just made deliberately uninformative.
 *
 * **Set-Cookie is re-attached one header at a time.** A callback response expires the state cookie, and
 * folding several cookies into one comma-joined header is how a browser that would have accepted them
 * silently keeps them instead.
 */
export function collapseProviderRefusal(requestPath: string, response: Response): CollapsedRefusal | undefined {
  // Only the OAuth callback issues this redirect. Scoped to it rather than applied to every `?error=`
  // this capability might ever return, so nothing else acquires a rewriting middleware by accident.
  if (!requestPath.includes("/callback/")) return undefined;
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get("location");
  if (!location) return undefined;

  let target: URL;
  try {
    target = new URL(location);
  } catch {
    // A relative or malformed Location carries no query this can read. Better Auth builds an absolute
    // one; anything else is not ours to rewrite.
    return undefined;
  }
  const code = target.searchParams.get("error");
  if (!code || PROVIDER_REFUSAL_VERDICTS[code]?.collapse !== true) return undefined;

  target.searchParams.set("error", NEUTRAL_PROVIDER_REFUSAL);
  target.searchParams.delete("error_description");

  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") headers.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  headers.set("location", target.toString());

  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    reason: code,
  };
}
