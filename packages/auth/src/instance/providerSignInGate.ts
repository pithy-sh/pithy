// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { AuthContext, BetterAuthPlugin, OAuthProvider } from "better-auth";
import { APIError, getOAuthState } from "better-auth/api";
import { correlation, emitDenied } from "../audit/emit";
import { NEUTRAL_PROVIDER_REFUSAL } from "../http/providerRefusal";

/**
 * One answer for both provider sign-in refusals, decided before Better Auth branches (#625).
 *
 * ## Reach, first, because that is the claim
 *
 * This plugin decorates `getUserInfo` on **every provider object Better Auth already built** — the live
 * `ctx.socialProviders` array, wrapped rather than replaced. So the guarantee is: **on the OAuth redirect
 * callback, for every provider this instance serves, rows 3 and 4 below are refused with one answer, and
 * neither `account_not_linked` nor `signup_disabled` is produced at all.**
 *
 * It does not reach three things, named here rather than left for a ninth round to find:
 *
 * - **`POST /sign-in/social` carrying an `idToken`** (`api/routes/sign-in.mjs:154-200`). That request
 *   returns before `generateState`, so there is no OAuth state and the gate cannot tell it from
 *   `/link-social`'s own id-token branch, which must be passed through. It reaches the same two codes.
 *   The mitigating fact is that it requires a provider-signed, audience-bound assertion of the address,
 *   so it is not an address an attacker picks — which is why the claim above says *the redirect
 *   callback* and not *provider sign-in*.
 * - **A plugin that calls `handleOAuthUserInfo` without going through `provider.getUserInfo`.**
 *   `plugins/one-tap/index.mjs:45-70` builds the user info straight from a verified Google id token;
 *   `plugins/oauth-proxy/index.mjs:110` lifts it out of an encrypted proxy payload. The kit composes
 *   neither. `./refusalTransport` is where a composed plugin is ruled on.
 * - **An adopter plugin that replaces `ctx.socialProviders` in its own `init`.** Kit plugins run first
 *   by contract (`./auth.ts` composes them ahead of the adopter's), so the wrap is installed before
 *   anything an adopter adds — but the plugin contract permits the replacement and nothing can detect
 *   it from in here. Same class of escape `./refusalTransport` already exists to bound.
 *
 * ## The defect
 *
 * Signing in with a provider while not signed in has four outcomes, and the first two are untouched by
 * everything below:
 *
 * | # | Situation | Outcome |
 * | --- | --- | --- |
 * | 1 | The provider identity is already attached to an account | Signs in |
 * | 2 | Not attached, and the provider's **verified** address matches an account | Links and signs in |
 * | 3 | Not attached, address unverified at the provider, an account exists there | Refused |
 * | 4 | Not attached, no account at that address | Refused |
 *
 * Rows 3 and 4 differ only in whether a row exists at an address **the caller chose**, and Better Auth
 * answers them with two different codes — `account_not_linked` (`oauth2/link-account.mjs:86`, returned
 * only inside `if (dbUser)`) and `signup_disabled` (`:202`, the `else` of that same branch). Both reach
 * the browser as `?error=<code>`. That is an account-enumeration oracle needing one provider account,
 * none on the target, and no page render.
 *
 * ## Why here, and not on the way out
 *
 * Eight earlier rounds rewrote the response instead. Each closed one transport and the next found
 * another, and the last keyed on a value `callbackURL` supplies, so it rewrote *successful* sign-ins.
 * By the time a response exists the fact that distinguished the two cases is gone and what is left is
 * partly the caller's. `getUserInfo` is the last seam that holds the fact itself: `callback.mjs:120`
 * calls it, `:220` calls `handleOAuthUserInfo`, and **nothing runs in between** — so a refusal thrown
 * here means neither of those two lines is ever reached and there is no pair left to collapse.
 *
 * ## Why a wrapper, and not a `getUserInfo` supplied in the config block
 *
 * `options.getUserInfo` short-circuits each provider's own resolver on its first line
 * (`social-providers/google.mjs:118`, `facebook.mjs:93`, `apple.mjs:62`, `github.mjs:65`), so supplying
 * one means reimplementing the profile fetch it replaced — Google's id-token decode, Facebook's
 * access-token-owner check. `./githubUserInfo.ts` already records what that costs: replacing GitHub's
 * resolver silently dropped `name` and `image`, which had to be re-derived. Wrapping calls the
 * dependency's own resolver and reads its result, so nothing is reimplemented and nothing reconstructed.
 *
 * **And it is the wrapping that makes the predicate read the right flag.** `mapProfileToUser` is applied
 * *inside* each provider's own `getUserInfo` — every one of the four spreads `...userMap` over the
 * `emailVerified` it computed — so the value this module reads is by construction the **effective** flag.
 * Facebook is the trap that makes this load-bearing: it sits outside `trustedProviders` like GitHub, but
 * `./auth.ts` asserts its address as verified with a documented reason, and its OAuth response carries no
 * `email_verified` claim at all. A predicate reading the raw provider payload would see nothing, conclude
 * unverified, and refuse a Facebook sign-in that works today. From in here the raw payload is not even in
 * scope to read by mistake.
 */

/**
 * The plugin id, reserved in `./plugins.ts` like the four Better Auth ones.
 *
 * Prefixed because it is the kit's own rather than a dependency's, and an adopter shadowing it would
 * silently win the registration — which for this plugin means silently removing the gate.
 */
export const PROVIDER_SIGN_IN_GATE_ID = "pithy-provider-sign-in-gate";

/**
 * What the trail records, which is the half the browser does not get.
 *
 * Two values, because the whole point is that the distinction survives *server-side*. They are the kit's
 * own words rather than Better Auth's two codes: those codes are no longer produced anywhere, and
 * recording a string the dependency can no longer emit would send the next reader looking for it.
 */
export const PROVIDER_SIGN_IN_REFUSAL_REASONS = {
  /** Row 3: an account exists at the address the provider asserted, and nothing licensed a link to it. */
  accountExists: "unlinked_identity_account_exists",
  /** Row 4: no account at that address, and this attempt may not create one. */
  noAccount: "unlinked_identity_no_account",
} as const;

/** What the gate needs from the instance: the audit seam, and enough of the request to attribute a row. */
export interface ProviderSignInGateDeps {
  /** Audit seam — where the true reason for a refusal goes, since the browser no longer gets it. */
  emit: AuditEmit;
  /**
   * This request's headers, for the `ip` and `user-agent` every other denial row carries.
   *
   * **Threaded rather than read from the flow, and it has to be.** `getUserInfo` is handed the OAuth
   * tokens and nothing else — no request, no endpoint context — so the only way this correlation reaches
   * the row is from where the instance is built, which is per request (`../http/resolve.ts`). Without it
   * these refusals would be the one kind of denial in the trail that cannot be counted per caller, which
   * is most of what a trail of refused sign-ins is for.
   *
   * `undefined` where no request built the instance — a seed, a test harness — and `correlation` already
   * answers that with two absent fields rather than a throw.
   */
  headers: Headers | undefined;
}

/** The token bag Better Auth hands `getUserInfo`, named off the dependency so it cannot drift. */
type UserInfoToken = Parameters<OAuthProvider["getUserInfo"]>[0];

/** What `getUserInfo` answers: the mapped user and the raw profile, or `null`. */
type UserInfoResult = Awaited<ReturnType<OAuthProvider["getUserInfo"]>>;

/**
 * Build the redirect a refusal leaves by.
 *
 * **This mirrors `oauth2/errors.mjs`'s `redirectOnError` deliberately, and the mirror is measured rather
 * than asserted:** `providerSignInGate.workers.test.ts` drives a refusal the dependency still emits
 * (`email_not_found`) beside one this gate emits and requires the two `Location` headers to differ in
 * nothing but the code. `ctx.redirect(url)` is itself only `new APIError("FOUND", undefined, headers)`
 * with `location` set (`better-call/dist/context.mjs:60`), and better-auth's router passes a `FOUND`
 * straight through its `onError` to `toResponse` (`api/index.mjs:192`), so this is the same object the
 * dependency would have thrown — built without the endpoint context `getUserInfo` is not handed.
 *
 * The value being appended to is the OAuth state's own `errorURL`, which is where `redirectOnError`
 * reads it from too, and which `../http/errorCallbackUrl` has already normalized on the way in.
 */
function refusalRedirect(errorURL: string): APIError {
  const separator = errorURL.includes("?") ? "&" : "?";
  const query = new URLSearchParams({ error: NEUTRAL_PROVIDER_REFUSAL }).toString();
  return new APIError("FOUND", undefined, new Headers({ location: `${errorURL}${separator}${query}` }));
}

/**
 * The refusal when the state carried no `errorURL` to redirect to.
 *
 * Unreachable on the callback — `parseState` fills `errorURL` from `onAPIError.errorURL` or
 * `${baseURL}/error` before it returns (`oauth2/state.mjs:61`) — and written anyway, because the
 * alternative to a refusal with nowhere to send it is passing the attempt through, which is the one
 * direction this module must never fail in.
 */
function refusalWithoutRedirect(): APIError {
  return new APIError("FORBIDDEN", {
    code: NEUTRAL_PROVIDER_REFUSAL,
    message: "That provider did not sign you in.",
  });
}

/**
 * Is this provider identity already attached to some account here? Row 1.
 *
 * **Keyed on `(providerId, accountId)`, which is wider than Better Auth's `(issuer, accountId)`, and
 * wider is the safe direction.** Deriving the issuer means copying `createOAuthAccountIssuer` —
 * `local:oauth:${encodeAccountIssuerProviderId(id)}` — from a package the kit does not depend on, and a
 * second copy of a dependency's decision is the defect class this repo has been bitten by four times
 * (#106, #108, #109, #113). A false match here passes the attempt through and lets Better Auth decide,
 * which is today's behavior; a false *miss* is what would be dangerous, and widening cannot cause one.
 *
 * It reads no address and no verified flag, which is what keeps an `allowDifferentEmails` link signing in.
 *
 * `ctx.adapter` rather than a Kysely query: the adapter already maps `account` to `pithyAuthAccounts`
 * and camelCase to snake_case, and a query written here would be a second spelling of that mapping.
 */
async function identityAlreadyAttached(
  ctx: AuthContext,
  provider: OAuthProvider,
  token: UserInfoToken,
  profile: object,
): Promise<boolean> {
  const subject = await provider.accountSubject({ tokens: token, profile });
  const accountId = String(subject);
  if (accountId.trim().length === 0) return false;
  const row = await ctx.adapter.findOne({
    model: "account",
    where: [
      { field: "providerId", value: provider.id },
      { field: "accountId", value: accountId },
    ],
  });
  // `undefined` as well as `null`: the contract says `T | null`, and an adapter answering the other
  // absent value would otherwise read as a match — which is the pass-through direction, but by accident.
  return row !== null && row !== undefined;
}

/**
 * Decide one social sign-in callback: pass it through, or refuse it identically whichever row it is.
 *
 * **Scope first, then decide, and the default is pass-through**, because pass-through is today's
 * behavior and is the only safe mispredict: an attempt this lets past is one Better Auth then rules on
 * exactly as it does now.
 */
async function gateProviderSignIn(args: {
  ctx: AuthContext;
  provider: OAuthProvider;
  token: UserInfoToken;
  result: NonNullable<UserInfoResult>;
  deps: ProviderSignInGateDeps;
}): Promise<void> {
  const { ctx, provider, token, result, deps } = args;

  // No OAuth state: `/link-social` and `/account-info` with an id token (`api/routes/account.mjs:174`,
  // `:609`), which never generate one, and `/sign-in/social`'s own id-token branch, which returns before
  // `generateState`. The first two must be untouched — linking from inside the account is a different
  // flow with both sides already proven — and the third is the uncovered path named in the reach section.
  //
  // **`getOAuthState()` throws where no request state was established**, which is every caller reaching
  // a provider object by hand rather than through an endpoint (`to-auth-endpoints.mjs:50` wraps them
  // all, `auth.api.*` included). Deliberately not caught: a missing store cannot be a callback today,
  // and swallowing it would turn a dependency that stopped establishing one into a silent pass-through
  // instead of a loud failure. There is no such caller in this kit.
  const state = await getOAuthState();
  if (state === null) return;

  // The link flow, which cannot be forged. `generateState` builds `{ ...options.additionalData, …,
  // link: options?.link, … }` (`oauth2/state.mjs:22-32`): the caller's `additionalData` is spread
  // **first** and `link` is assigned last, so a `/sign-in/social` always overwrites an injected `link`
  // with `undefined`, which `JSON.stringify` then drops from both the database and cookie strategies.
  // Verified, load-bearing, and planted against — the gate keys on this field.
  if (state.link !== undefined && state.link !== null) return;

  // No address at all. Better Auth answers `email_not_found` from `callback.mjs:205`, which is the same
  // string on both sides of the fork, so there is nothing here to collapse and nothing to decide. The
  // kit's own GitHub resolver fails closed to exactly this shape (`./githubUserInfo.ts`).
  const email = result.user.email;
  if (!email) return;

  // Row 1.
  if (await identityAlreadyAttached(ctx, provider, token, result.data)) return;

  const local = await ctx.internalAdapter.findUserByEmail(email);

  // Row 2, as the two halves of `link-account.mjs:83` — read from the dependency's own resolved values
  // rather than restated. `emailVerified` here is the **effective** flag: this is the return of the
  // provider's own `getUserInfo`, so `mapProfileToUser` has already run and Facebook's forced `true` is
  // already in it.
  //
  // The third half of that condition, `requireLocalEmailVerified && !dbUser.user.emailVerified`, is
  // mirrored rather than assumed away. It is the corner the issue names: without it, a local row with
  // `emailVerified: false` would be read as row 2, passed through, and refused by Better Auth as
  // `account_not_linked` — the oracle intact in a corner. The kit's own doors cannot write such a row
  // (passwordless sign-up writes `true`; `isUnverifiedSignup` refuses any unverified social create), and
  // that assertion is tested — but mirroring costs one clause and does not depend on the assertion
  // holding for an adopter's plugin.
  const providerVouches = ctx.trustedProviders.includes(provider.id) || result.user.emailVerified === true;
  const requireLocalEmailVerified = ctx.options.account?.accountLinking?.requireLocalEmailVerified ?? true;
  const localVouches = !requireLocalEmailVerified || local?.user.emailVerified === true;
  if (local && providerVouches && localVouches) return;

  // Rows 3 and 4. **Refuse only where Better Auth certainly would**, or a legitimate sign-up dies:
  // `allowSignUp` defaults to true (`../capability.ts`), so a verified address with no account is an
  // ordinary sign-up on the default configuration and a blanket "neither row 1 nor row 2" would turn
  // every first provider sign-up into a refusal. Three ways the refusal is certain:
  //
  // - **A local row exists.** Better Auth never creates a user when one matched, and row 2 has just
  //   failed, so `link-account.mjs:86` is where that attempt ends.
  // - **Sign-up is disabled for this provider** — `provider.options.disableSignUp`, which is the kit's
  //   own `signUpOption()` output (`./auth.ts`) read back off the object rather than restated.
  //   `callback.mjs:229` also ORs in `disableImplicitSignUp && !requestSignUp`; ignoring that half is
  //   deliberate, since the kit never sets it and ignoring it can only cause a pass-through.
  // - **The address is not verified**, which the kit's own `user.create.before` hook refuses anyway.
  const certain = local !== null || provider.options?.disableSignUp === true || result.user.emailVerified !== true;
  if (!certain) return;

  // The true reason, server-side, where the acceptance criteria want it and the browser does not get it.
  // Emitted before the throw so the trail holds the attempt whether or not anything logs the refusal;
  // `emitDenied` swallows its own failure by contract.
  await emitDenied(deps.emit, {
    ...correlation(deps.headers),
    detail: local ? PROVIDER_SIGN_IN_REFUSAL_REASONS.accountExists : PROVIDER_SIGN_IN_REFUSAL_REASONS.noAccount,
  });
  const errorURL = typeof state.errorURL === "string" ? state.errorURL : undefined;
  throw errorURL ? refusalRedirect(errorURL) : refusalWithoutRedirect();
}

/**
 * The kit's provider sign-in gate, as a Better Auth plugin.
 *
 * `init` is handed the live `AuthContext` — `runPluginInit` runs after `create-context.mjs` has built
 * every provider and stored the finished array on `ctx.socialProviders`, and `Object.assign`s whatever
 * the plugin returns. So this is the one seam that reaches **all** providers without naming any of them:
 * a provider an adopter's config adds later is wrapped by the same loop.
 *
 * **`ctx.internalAdapter` is read at call time and never captured**, because `runPluginInit` *replaces*
 * `context.internalAdapter` after the plugin loop (`context/helpers.mjs:47`). Capturing it in `init`
 * would hold the pre-hook adapter. `ctx.trustedProviders` is closed over, which is sound while the kit's
 * own value is the static `["google", "apple"]` it sets in `./auth.ts`; `auth/base.mjs` recomputes it on
 * a per-request clone, so this would need revisiting if it ever became a function of the request.
 */
export function providerSignInGate(deps: ProviderSignInGateDeps): BetterAuthPlugin {
  return {
    id: PROVIDER_SIGN_IN_GATE_ID,
    init: (ctx) => {
      for (const provider of ctx.socialProviders) {
        const resolve = provider.getUserInfo.bind(provider);
        provider.getUserInfo = async (token) => {
          const result = await resolve(token);
          // Nothing resolved is nothing to rule on: Better Auth answers `unable_to_get_user_info`, which
          // is the same string whatever is in the user table, and the kit's GitHub resolver fails closed
          // to it on purpose so an outage does not read as "your account does not exist".
          if (!result?.user) return result;
          await gateProviderSignIn({ ctx, provider, token, result, deps });
          return result;
        };
      }
    },
  };
}
