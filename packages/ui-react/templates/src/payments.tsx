import { getEntitlements } from "@pithy-sh/payments/src/client/api";
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
 * Whether the visitor holds `key` right now.
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
