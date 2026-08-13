import { getEntitlements } from "@pithy-sh/payments/src/client/api";
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
