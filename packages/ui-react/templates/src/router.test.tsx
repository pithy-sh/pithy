// @vitest-environment happy-dom

import { expect, test } from "vitest";
import { buildRoutes, type RouteModule, type ScreenRole, screenPath } from "./router";

/**
 * **A guard's destination is the path the screen declares, never a copy of it.**
 *
 * The router used to hold its own `SIGN_IN_PATH = "/sign-in"` and `PAYWALL_PATH = "/paywall"`. The
 * other end of each was an `export const path` in a different file, typed `string`, with nothing
 * comparing them. Renaming a screen's path — `/sign-in` to `/login`, the most ordinary rebrand there
 * is — typechecked, linted, built, and left the signed-out guard redirecting to the not-found screen.
 *
 * Nobody signed in would ever see it (#393).
 *
 * ## What this proves, and how it goes red
 *
 * The table is built from a screen this file invents, whose path is **deliberately not** any real
 * one. A router holding a literal would still send visitors to `/sign-in`, and this goes red; only one
 * that reads the screen's declared path can pass. The expected value is reachable from nowhere else —
 * asserting the real path would pass against the very drift this catches.
 *
 * The second case is the other half: a role nothing claims must fail loudly rather than send somebody
 * nowhere. A guard with no destination is a screen that never resolves, and silence is what this whole
 * class of defect is made of.
 */

/** The path the invented sign-in screen declares. Not the real one, on purpose. */
const CANARY_SIGN_IN = "/pithy-gate-canary-not-the-sign-in-path";

/** The same for the paywall, so one role passing cannot cover for the other. */
const CANARY_PAYWALL = "/pithy-gate-canary-not-the-paywall-path";

/** A screen in the shape `router.tsx` documents: a declared path, a role, and a component. */
function screen(path: string, role: ScreenRole): () => Promise<RouteModule> {
  return async () => ({ path, role, default: () => null });
}

test("a guard is sent to the path the screen claiming the role declares", async () => {
  // The canaries must not have drifted onto the real paths: either would pass against the bug.
  expect(CANARY_SIGN_IN).not.toBe("/sign-in");
  expect(CANARY_PAYWALL).not.toBe("/paywall");

  const table = await buildRoutes([screen(CANARY_SIGN_IN, "sign-in"), screen(CANARY_PAYWALL, "paywall")]);

  expect(screenPath(table, "sign-in")).toBe(CANARY_SIGN_IN);
  expect(screenPath(table, "paywall")).toBe(CANARY_PAYWALL);
});

test("a screen in app/ takes the job over, the same way it takes a pattern over", async () => {
  const mine = "/pithy-gate-canary-my-own-sign-in";
  expect(mine).not.toBe(CANARY_SIGN_IN);

  // Pithy's screens are registered first, yours second — so yours is the one a guard ends up at.
  const table = await buildRoutes([screen(CANARY_SIGN_IN, "sign-in"), screen(mine, "sign-in")]);

  expect(screenPath(table, "sign-in")).toBe(mine);
});

test("a role no screen claims is an error with a stack, not a redirect to nowhere", async () => {
  const table = await buildRoutes([]);
  expect(() => screenPath(table, "sign-in")).toThrow(/sign-in/);
});
