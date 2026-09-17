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
 *
 * ## This module is the second line of defense, not the only one
 *
 * It reads the `Location` a refused callback answered with — which is the output of
 * `redirectOnError`'s raw string concatenation (`callback.mjs:78`), performed on a value the caller
 * supplied. It was walked around twice that way, and the second bypass was the diagnosis: **every input
 * shape where that concatenation and this parsing disagree is another one**, so patching the parsing
 * again only moves the report later. `./errorCallbackUrl` therefore guards the value on the way *in*,
 * and by the time this module runs the string being parsed is one the kit produced.
 *
 * **Both stay.** That module decides what the dependency is handed; this one still checks what it
 * answered. An input guard that depends on out-guessing a dependency's string handling is exactly what
 * round 3 exists to stop relying on — so the guess is made once, about a value the kit then owns, and
 * checked again here against the roster. Neither is asked to carry the whole load.
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
 * `providerRefusal.test.ts` reads Better Auth's own `OAUTH_CALLBACK_ERROR_CODES`, scans the
 * `result.error` literals out of `link-account.mjs`, and scans the `new APIError(…, { code })` sites in
 * both codebases — `better-auth`'s on the callback's path and the kit's across this whole package,
 * because `callback.mjs:239` re-emits *anything* thrown inside `handleOAuthUserInfo` as `?error=`. Every
 * code any of them can produce must appear here. A dependency bump that adds one turns that red, and
 * somebody writes a verdict for it. So the roster records a *review*, and the review cannot silently fall
 * behind the thing it reviews.
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
  INVALID_PROFILE_FIELD: {
    collapse: true,
    why: "The kit's `user.update.before` hook, and **the branch it sits on was read wrong the first time.** `if (dbUser) {` opens at link-account.mjs:77 and the `if (!linkedAccount) {…} else {…}` pair sits *inside* it, so the ownership argument that carries `unable_to_update_account` does not reach here: the `updateUser` that can carry a provider's `name`/`image` is the `overrideUserInfo` write at :185, which runs after **either** sub-branch — including the one that has just linked an account that did not exist a line earlier. What every path to it does share is `if (dbUser)`: a matched row. The other side of that branch calls `createUser`, where the kit's `user.create.before` **sanitizes** the same two fields instead of refusing them. So a hostile provider display name answers `?error=INVALID_PROFILE_FIELD` against an address that has a row and a completed sign-in against one that does not, which is the oracle with a different name on it.",
  },
  validation_context_missing: {
    collapse: true,
    why: "internal-adapter.mjs:160 — raised when `getCurrentAuthContext()` fails inside `createUser`, and `createUser` is the no-row side. `updateUser` runs no such check (internal-adapter.mjs:599), so this code cannot be observed against an address that has a row: it is `signup_disabled`'s shape reached through the adopter's `validateUserInfo` option rather than through the sign-up policy.",
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
  account_hook_binding_conflict: {
    collapse: false,
    why: "link-account.mjs:120/176/237 — a hook moved the account binding out from under the write that had just been made. Raised on the link path, the sign-in path *and* the create path, so it is reached from both sides of `if (dbUser)` equally and names neither.",
  },
  validation_source_missing: {
    collapse: false,
    why: "validate-user-info.mjs:5/9/13 — the `source` handed to the adopter's `validateUserInfo` gate did not name a method or a provider. A fact about the call Better Auth just built, identical on both sides of the branch, and settled before the gate is even asked.",
  },
  validation_failed: {
    collapse: false,
    why: "validate-user-info.mjs:34 — the adopter's own `validateUserInfo` callback threw, and Better Auth fails closed. Called on the link path (link-account.mjs:92), the sign-in path (:137) and the create path (internal-adapter.mjs:164), so it is reachable whether or not a row matched. What that callback *returns* is the adopter's own code and travels off-roster, which is the same decision as for the provider's own `error` values.",
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
    why: "link-account.mjs:172, inside `if (linkedAccount)` — reaching it requires an account row already binding this provider identity to this user, and the caller proved control of that identity at the provider to get here. Ownership, not a matched row. (This is the argument `INVALID_PROFILE_FIELD` was wrongly given: that code's write sits outside this branch.)",
  },

  // ── The account-selection flow, which the social callback never enters. ────────────────────────
  // Every code below is guarded by `opts.selectedUser` or by `opts.requireExactAccountBinding`, and
  // `callback.mjs` passes neither to `handleOAuthUserInfo`. They are rostered because the completeness
  // gate scans the file rather than the reachable subset of it — and "cannot be reached from here" is a
  // verdict a reader can check, where silence is not.
  account_ownership_conflict: {
    collapse: false,
    why: "link-account.mjs:38, inside `if (opts.selectedUser && …)`. The lookup it reports on is keyed by the *provider* identity the caller has just proved control of, not by an address handed over — and the social callback passes no `selectedUser`, so this never reaches that redirect at all.",
  },
  account_provider_conflict: {
    collapse: false,
    why: "link-account.mjs:42, guarded by `requireExactAccountBinding`, which is `opts.selectedUser || opts.requireExactAccountBinding` — neither of which `callback.mjs` passes. Keyed by the caller's own provider identity, as above.",
  },
  user_not_found: {
    collapse: false,
    why: "link-account.mjs:54 — `findUserById(opts.selectedUser.userId)`, so it answers about a user id the caller was already handed, on a flow the social callback does not enter. It reads a row by id, never by a provider-resolved address.",
  },
  user_hook_selection_conflict: {
    collapse: false,
    why: "link-account.mjs:195, inside `if (opts.selectedUser …)`. A hook returned a different user than the one the caller picked from a list they had already been shown, and the social callback never picks one.",
  },
  session_hook_user_conflict: {
    collapse: false,
    why: "link-account.mjs:275 — after the user is resolved and the session minted, under the same `requireExactAccountBinding` gate. Reached from both sides of `if (dbUser)` when it is reached at all, which on the social callback is never.",
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
  /**
   * The code that was taken off the wire — for the audit trail, and for nothing else.
   *
   * Space-separated when the header carried more than one collapsing `error`, which it can: Better Auth
   * *appends* its code to whatever the adopter's error URL already had. Recording only the first would
   * put a caller-supplied value in the trail's place.
   */
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
 *
 * ## Two things the caller chooses, and neither may choose the answer
 *
 * The `Location` this reads is built from `errorCallbackURL`, which arrives in the body of
 * `POST /sign-in/social`. An earlier draft read it as though Better Auth had built the whole thing, and
 * both halves of that assumption were wrong:
 *
 * - **It need not be absolute.** `api/middlewares/origin-check.mjs` passes `allowRelativePaths: true`,
 *   `matchesOriginPattern` admits `/path?query`, `oauth2/state.mjs` stores the value as a bare
 *   `z.string().optional()`, and `redirectOnError` concatenates it raw. So a relative `Location` is a
 *   supported answer, and returning `undefined` to one sent the true code to the browser and wrote no
 *   audit row.
 * - **`error` need not be the only one.** `redirectOnError` *appends* `&error=<code>`. An
 *   `errorCallbackURL` ending `?error=access_denied` therefore answers
 *   `?error=access_denied&error=account_not_linked`, and `searchParams.get` reads the planted value.
 *
 * So: a relative target is resolved against the request the way a browser resolves it, and **every**
 * `error` value is put to the roster rather than the first.
 *
 * **Both of those shapes are now refused or normalized before the flow starts** (`./errorCallbackUrl`),
 * and this handling stays anyway — the collapse still has to work on a `Location` whose `errorURL`
 * came from `defaultErrorURL` rather than from a caller, and on whatever a future dependency writes
 * there. What it cannot do is be the only guard: the third bypass was a fragment, and a fragment is
 * precisely the shape a query parser cannot see. That is the whole argument for the other end.
 *
 * @param requestUrl The absolute URL of the request being answered — the callback's own, which a relative
 *   `Location` resolves against. Callers pass `c.req.raw.url`.
 */
export function collapseProviderRefusal(requestUrl: string, response: Response): CollapsedRefusal | undefined {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return undefined;
  }
  // Only the OAuth callback issues this redirect. Scoped to it rather than applied to every `?error=`
  // this capability might ever return, so nothing else acquires a rewriting middleware by accident.
  // Matched against the path alone, so a query parameter cannot talk its way into this branch.
  if (!request.pathname.includes("/callback/")) return undefined;
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get("location");
  if (!location) return undefined;

  let target: URL;
  try {
    target = new URL(location);
  } catch {
    try {
      target = new URL(location, request);
    } catch {
      // Not a location any resolution accepts, so it carries no query to read and no target to rewrite.
      return undefined;
    }
  }

  // The verdicts decide, and all of them do. One collapsing code anywhere in the list is the whole
  // condition — the caller controls the order, so "the first one" is the caller's answer, not the roster's.
  const collapsing = target.searchParams
    .getAll("error")
    .filter((code) => PROVIDER_REFUSAL_VERDICTS[code]?.collapse === true);
  if (collapsing.length === 0) return undefined;

  // `set` replaces the first `error` and drops the rest, which is exactly the contract: one answer. A
  // value the caller planted beside the real one is not a second answer worth forwarding.
  target.searchParams.set("error", NEUTRAL_PROVIDER_REFUSAL);
  target.searchParams.delete("error_description");

  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") headers.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  // A root-relative target goes back root-relative, because that is what the adopter configured and this
  // Worker's own origin is not necessarily theirs. Only that one shape: `//host/path` is *also* relative
  // and resolves to another origin, so answering it as `/path` would quietly retarget the redirect here.
  const rootRelative = location.startsWith("/") && !location.startsWith("//");
  headers.set("location", rootRelative ? `${target.pathname}${target.search}${target.hash}` : target.toString());

  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    reason: collapsing.join(" "),
  };
}
