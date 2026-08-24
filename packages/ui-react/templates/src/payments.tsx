import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { getEntitlements, type PaymentsFailure } from "@pithy-sh/payments/src/client/api";
import type { PriceVisitor } from "@pithy-sh/payments/src/pricing/location";
import { fetchPriceVisitor, type PriceVisitorOptions } from "@pithy-sh/payments/src/pricing/visitor";
import { useEffect, useState } from "react";
import { paymentsConfig } from "./pithy-config";

/**
 * The thin bridge between the narrowed projection and the package's headless hooks.
 *
 * Two things live here and nothing else. {@link paymentsClient} binds every call to this project's own
 * base path, once, so a screen never repeats it — and because it is a module constant it is a stable
 * reference, which keeps the hooks' effects from re-running on every render.
 *
 * {@link holdsEntitlement} is the data half of the router's entitlement guard. The guard is a **UX
 * affordance, never a security boundary**: the server's `requireEntitlement()` is the boundary, and this
 * exists so a visitor without `pro` lands on the paywall instead of watching a screen 403. Anything this
 * answers wrongly costs a redirect, never access.
 *
 * Everything the purchase flow actually does — the calls, the redirect-and-return dance, the error
 * mapping — lives in `@pithy-sh/payments`, not here. That split is deliberate: this file is written once
 * and is yours from then on, and store rules move. A paywall frozen in an adopter's repo is one Pithy
 * cannot fix; a paywall that calls the package's hooks upgrades with a minor release.
 */

/** Where the payments routes are, bound once. Pass it to every hook. */
export const paymentsClient = { basePath: paymentsConfig.basePath };

/**
 * The class Paddle renders an inline checkout into.
 *
 * A class name, not an id — that is Paddle's `frameTarget` contract. The container is rendered only when
 * the handoff asks for it, from `paddle.checkout` in your config: switch that to `inline` and the form
 * appears in the page instead of over it, with no edit to any screen.
 *
 * **It is here because two screens sell.** The paywall and the pricing page each declared their own copy
 * of this string, and the class is the one thing about it you are meant to act on — `.pithy-checkout` is
 * an adopter hook, deliberately styled by no stylesheet Pithy ships, so that the frame lands where your
 * layout wants it. A styling instruction against two names that agree today is one that styles half your
 * checkouts the day somebody renames one (#391, item E).
 *
 * That is also why the unstyled report never mentions it: it has no rule anywhere on purpose, and a
 * class read out of an identifier is not a literal that report can see. Both facts are intended.
 */
export const CHECKOUT_FRAME = "pithy-checkout";

/**
 * What Paddle.js starts with, or null when this project has no Paddle rail.
 *
 * Null rather than absent, because every hook that takes it takes null and reads it as "nothing to
 * load". That is what keeps a pricing screen free of a conditional hook call, and it is why the rail
 * being switched off is an empty state rather than an error about a provider nobody asked for.
 *
 * **The client token is the only credential in this bundle, and it belongs here.** Paddle publishes it
 * for exactly this — a browser opens a checkout with it. The API key and the webhook signing secret are
 * in the secrets store and are not expressible in a projection.
 */
export const paddleSetup = paymentsConfig.paddle;

/**
 * What a refusal from the store reads as, in the reader's language.
 *
 * **A `PaymentsFailure` carries a namespaced `code`, and the code is the catalog key.** Every screen
 * here used to render `failure.message` — the sentence the server put on the wire, which is English and
 * is only ever English, because `message` is written at the throw site in the one language a throw site
 * has. So a reader on an otherwise-Spanish page met English the moment anything went wrong, which is
 * the moment copy matters most and the moment nobody tests.
 *
 * This is the contract `docs/I18N.md` § *Errors* states, and the reason it is `maybe` rather than `t`:
 * `t` is total, so a code no catalog covers would render as the code itself — `payments/product_not_found`
 * on a buyer's screen, in place of the English sentence the server took care to send. `maybe` answers
 * null on a miss, and the `??` is what makes the server's own words the floor.
 *
 * So a project that never composed `i18n` renders exactly what it always did, byte for byte: the baked
 * translator holds only the screen's own English, no key matches a `payments/…` code, and the message
 * comes straight through. The `client/…` sentinels this package mints for a browser that is offline or
 * an answer it cannot read take the same path, and their English is likewise unchanged.
 *
 * It lives here, with `CHECKOUT_FRAME`, for the same reason that does: three screens render a failure,
 * and three copies of one lookup is two screens that keep saying it in English the day somebody fixes
 * the third.
 */
export function failureText(t: Translator, failure: PaymentsFailure): string {
  // `params` and not just the code: `interpolate` leaves an unsupplied placeholder exactly as written,
  // so a translated sentence that names one would render `{board}` on the screen — worse than the
  // English it replaced. `docs/I18N.md` states the contract as `t.maybe(code, params) ?? message`.
  return t.maybe(failure.code, failure.params) ?? failure.message;
}

/**
 * Whether the visitor holds `key` right now.
 *
 * "The visitor" is shorthand for whoever the server says this session holds entitlements for — the person
 * under a project that bills users, the organization they are acting for under one that bills
 * organizations. Nothing here names either, and nothing here should: the read carries the session and the
 * server decides the holder, so no argument this file could pass would be one it was entitled to choose.
 *
 * `true` when payments is not composed, which is the same direction the session guard takes when there is
 * no auth: a guard that arrives with a capability must not lock a screen when the capability is gone. The
 * server is what protects the feature.
 *
 * A read that fails answers `false` — this is a route guard, so it is a lock, and a lock fails shut. The
 * choice is written here rather than inherited from the reader: a caller that *named* the visitor's plan
 * would need the opposite, and `getEntitlements` hands both callers the same honest answer.
 */
export async function holdsEntitlement(key: string): Promise<boolean> {
  if (!paymentsConfig.enabled) return true;
  const held = await getEntitlements(paymentsClient);
  return held.ok && held.value.some((entitlement) => entitlement.key === key && entitlement.granted);
}

/**
 * Who Paddle prices this visitor as, once there is a session to ask about.
 *
 * The customer it answers is the store customer for whoever the session holds purchases for — a person, or
 * the organization they buy on behalf of — read on the server from that session and never named here.
 *
 * **Two renders, and that is the design rather than a flicker to hide.** A pricing screen paints before
 * the session resolves, so the first figure is the IP estimate — labelled `Estimated.`, because it is —
 * and the second is the price the checkout will charge, from the billing address on file. Every checkout
 * on the web recalculates when the address arrives; the only thing that makes it a broken promise is a
 * first figure that did not admit what it was.
 *
 * `ask` is false for a stranger and while the session is still being read, so a marketing page makes no
 * round trip for an answer known in advance to be "nobody".
 *
 * The reading and the guarding live in `@pithy-sh/payments`, not here — this file is yours from the day
 * it is written, and where a customer id comes from is not a thing to freeze into your repository. A
 * failed read answers null, which quotes from the IP and says so.
 */
export function usePriceVisitor(ask: boolean, options?: PriceVisitorOptions): PriceVisitor | null {
  const [visitor, setVisitor] = useState<PriceVisitor | null>(null);

  useEffect(() => {
    if (!ask || !paymentsConfig.enabled) return;
    let live = true;
    void fetchPriceVisitor(options).then((answer) => {
      if (live) setVisitor(answer);
    });
    return () => {
      live = false;
    };
    // `options` is `paymentsClient`, a module constant, so this asks once per session resolution.
  }, [ask, options]);

  return visitor;
}
