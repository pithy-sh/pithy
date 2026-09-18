// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Which composed plugins can answer a callback refusal somewhere the collapse cannot read (#625).
 *
 * ## What the collapse actually covers
 *
 * `../http/providerRefusal` reads one thing: the `Location` header of the Response
 * `instance.handler()` returned. So the guarantee it gives is exactly that — **a refusal that leaves
 * this Worker through that header is collapsed to one neutral code**. Everything the kit itself composes
 * answers that way, because Better Auth's social callback answers that way. A plugin an adopter composes
 * need not.
 *
 * ## The sixth round, and why it is not a sixth channel guard
 *
 * Five rounds each closed one transport for a malformed `errorCallbackURL` — a relative `Location`, a
 * planted `error` parameter, a fragment, a body the prefilter did not read, a query string — and each
 * time the next shape was found somewhere else. The sixth needs no malformed input at all.
 *
 * `better-auth/plugins`' own `oauthPopup()` registers an `after` hook matching `/callback/…`. Its
 * handler reads the `location` Better Auth just wrote, lifts `error` and `error_description` off it, and
 * assigns `c.context.returned` a **200 HTML page** that posts those values to the opener
 * (`dist/plugins/oauth-popup/index.mjs:216-226`). By the time `handleBetterAuth` sees the response there
 * is no redirect left to collapse and the revealing code is in a body. Drive
 * `/auth/oauth-popup/start` with a perfectly well-formed `errorCallbackURL` — no fragment, nothing to
 * normalize, nothing an input guard could object to — and the account-enumeration oracle is whole.
 *
 * **So there is nothing left to guard on the way in.** Either the kit collapses refusals wherever a
 * composed plugin might put one, which is unbounded because a plugin may write any response it likes, or
 * it says which compositions its guarantee covers and refuses the rest at the door. This module is the
 * second. It is a scope decision: the claim is bounded to what the kit can actually hold.
 *
 * ## Why this is a roster of ids and not a property of a plugin object
 *
 * The honest predicate — the thing that separates `oauth-popup` from every plugin that is fine — is that
 * its hook **replaces** the response rather than amending its headers. That is a fact about the body of a
 * function. What a composed plugin object exposes at `auth()` is its `id`, its hook `matcher`s, which can
 * be called, and its `handler`s, which are opaque.
 *
 * Calling the matchers is possible, and sound in the direction that matters: a plugin that rewrites the
 * callback's response has to register an `after` hook that claims the callback path, because
 * `BetterAuthPlugin` offers no other seam for it. It is also far too wide to be a refusal. Measured
 * against `better-auth` 1.7.1 — every plugin its barrel exports, constructed, every `after` matcher asked
 * about `/callback/:id`, `/callback/github` and `/oauth2/callback/:id` — seven say yes: `anonymous`,
 * `bearer`, `last-login-method`, `multi-session`, `one-time-token`, `oauth-proxy` and `oauth-popup`.
 * `matcher: () => true` is the ordinary idiom for a hook that only wants to read `set-cookie`. Six of the
 * seven amend headers and nothing else, so refusing on that property would print, six times out of seven,
 * a claim about a plugin that is not true of it. A gate whose stated reason is wider than its actual
 * reason is the defect this round exists to stop repeating, one level up.
 *
 * **So the rule is a list, and its completeness is gated rather than asserted.**
 * `refusalTransport.test.ts` scans `better-auth`'s own shipped plugin sources for the assignment that
 * *is* the real predicate — `…context.returned = …` — and requires every plugin family it finds to carry
 * a verdict here. Same shape as `../http/providerRefusal`'s code roster, for the same reason: the review
 * is written down, and it cannot silently fall behind the thing it reviews. A bump that teaches a new
 * plugin to replace the callback's response turns that red naming the directory.
 *
 * ## What this does not reach, stated rather than left to be inferred
 *
 * An adopter's **own** plugin can assign `context.returned` on the callback exactly as `oauthPopup` does,
 * and nothing here will know. This gate runs inside their Worker while `pithy.config.ts` loads, where the
 * only thing in hand is the object; the source scan reaches `better-auth`'s plugins because their source
 * is on disk in a place the kit's own test suite can read, which is not true of an adopter's repo at
 * `auth()`. The guarantee is therefore bounded, and every docblock that states it says so: **the kit's own
 * routes, and any composed plugin that answers refusals through `Location`.**
 */

/** Whether a Better Auth plugin can answer a callback refusal off the `Location` header, and why. */
export interface RefusalTransportVerdict {
  /**
   * The directory under `better-auth/dist/plugins/` this verdict was read from.
   *
   * Recorded rather than derived from the key, because the two are not the same string in general — the
   * `haveibeenpwned` directory ships a plugin whose id is `have-i-been-pwned`. The completeness gate
   * compares directories, since a source scan finds files.
   */
  readonly source: string;
  /**
   * `true` when the plugin answers a refused callback through something other than the `Location` header,
   * which is the only transport the collapse reads. Such a plugin is refused at composition.
   */
  readonly outsideLocation: boolean;
  /** Why. Written for the next person asked to make an exception, and for the next dependency bump. */
  readonly why: string;
}

/**
 * Every `better-auth` plugin that replaces the response on a path the social callback reaches, reviewed.
 *
 * Keyed by plugin id, which is what `assertAdditivePlugins` has in hand. Two entries today because two
 * plugins in `better-auth` 1.7.1 assign `context.returned` at all, and the completeness gate is what
 * keeps that number honest on the next bump.
 */
const REFUSAL_TRANSPORT_VERDICTS: Readonly<Record<string, RefusalTransportVerdict>> = {
  "oauth-popup": {
    source: "oauth-popup",
    outsideLocation: true,
    why: "oauth-popup/index.mjs:216-226 — the after hook matches `/callback/` and `/oauth2/callback/`, reads `error` and `error_description` off the `location` Better Auth just wrote, and assigns `c.context.returned` a 200 HTML page carrying both in a JSON script block for `postMessage`. The redirect the collapse reads never leaves the Worker, so `account_not_linked` against `signup_disabled` is legible to anyone who can open the popup. Nothing about the request needs to be malformed.",
  },
  "oauth-proxy": {
    source: "oauth-proxy",
    outsideLocation: false,
    why: "oauth-proxy/index.mjs:331 assigns `context.returned`, but on the `/sign-in/social` hook, which answers the provider's authorize URL and carries no refusal this roster is about. Its callback hook (:340) touches only the `location` header, and only to swap in a `callbackURL` the same header already carried — so a refusal reaching it stays a refusal in `Location`, where the collapse still reads it.",
  },
};

/** The roster, for the completeness gate. Not part of the package's surface. */
export const REFUSAL_TRANSPORT_ROSTER: Readonly<Record<string, RefusalTransportVerdict>> = REFUSAL_TRANSPORT_VERDICTS;

/** The plugin ids `auth()` refuses. Derived from the roster, so the gate and the review cannot disagree. */
export const REFUSED_PLUGIN_IDS: readonly string[] = Object.entries(REFUSAL_TRANSPORT_VERDICTS)
  .filter(([, verdict]) => verdict.outsideLocation)
  .map(([id]) => id);

/** The written verdict for a plugin id, or `undefined` when nobody has had to rule on that plugin. */
export function refusalTransportVerdict(id: string): RefusalTransportVerdict | undefined {
  return REFUSAL_TRANSPORT_VERDICTS[id];
}
