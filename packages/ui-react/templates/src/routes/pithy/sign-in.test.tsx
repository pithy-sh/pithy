// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

/**
 * **The magic link comes back to the callback screen's declared path, never to a copy of it.**
 *
 * A magic link is issued with a `callbackURL`, and the screen that answers it is
 * `src/routes/pithy/callback.tsx`. Those used to be two strings: a `` `${origin}/callback` `` template
 * here and an `export const path = "/callback"` there, with nothing comparing them. Renaming the
 * screen's path — an ordinary rebrand — typechecked, linted, built, and broke every sign-in, because
 * the link then landed on the not-found screen (#393).
 *
 * It is the one flow you cannot test by being signed in, so nothing about your day would tell you.
 *
 * ## What this proves, and how it goes red
 *
 * `./callback` is stubbed with a path that is **deliberately not** the real one. A screen that wrote
 * the callback path as a literal would still send `/callback`, and this goes red; only one that reads
 * the screen's own export can pass. The expected value is invented here and reachable from nowhere
 * else — asserting `"/callback"` would have passed against the exact drift this catches.
 *
 * `@pithy-sh/auth`'s client API is stubbed to record rather than send: what is under test is the
 * string this screen builds, not the request the kit makes with it. `src/pithy-config.tsx` is stubbed
 * for the reason `src/turnstile.test.tsx` gives — it reads `virtual:pithy/*` modules that only a Vite
 * build serves, and stubbing it keeps this gate running under the plain `vitest run` you already have.
 */

/** The path the stubbed callback screen declares. Not the real one, on purpose. */
const CANARY_CALLBACK = "/pithy-gate-canary-not-the-callback-path";

/** The origin the screen is told it is on, so the assertion is about the whole URL. */
const ORIGIN = "https://gate.example";

vi.mock("./callback", () => ({ path: CANARY_CALLBACK, default: () => null }));

vi.mock("../../pithy-config", () => ({
  authConfig: { basePath: "/auth", providers: {}, signUpEnabled: true },
  turnstileConfig: { enabled: false, sitekey: "", mode: "visible", action: "", token: { field: "", header: null } },
}));

/** Every `callbackURL` the screen handed the kit, in order. */
const issued: string[] = [];

vi.mock("@pithy-sh/auth/src/client/api", () => ({
  sendMagicLink: async (body: { callbackURL: string }) => {
    issued.push(body.callbackURL);
  },
  startSocialSignIn: async (body: { callbackURL: string }) => {
    issued.push(body.callbackURL);
    return { kind: "silent" as const };
  },
}));

// React refuses to run `act` unless the environment says it is a test one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A projection with one provider on, so both ways out of this screen are exercised. */
const AUTH = { basePath: "/auth", providers: { google: true }, signUpEnabled: true };

test("the link comes back to whatever path callback.tsx declares", async () => {
  // The canary must not have drifted onto the real path: `/callback` would pass against the bug.
  expect(CANARY_CALLBACK).not.toBe("/callback");

  // Imported inside the case so the stubs are in place before this module's scope reads them.
  const { SignInScreen } = await import("./sign-in");

  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(<SignInScreen auth={AUTH} origin={ORIGIN} />);
  });

  const field = host.querySelector<HTMLInputElement>("input[type=email]");
  expect(field, "the sign-in screen rendered no email field").not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, "someone@example.com");
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(issued, "the screen sent no magic link").toHaveLength(1);
  expect(issued[0]).toBe(`${ORIGIN}${CANARY_CALLBACK}`);
});

test("this screen still claims the role the router's guard looks up", async () => {
  // Not two copies of a path: a job name, and the screen that says it does that job. Delete the claim
  // and every signed-out visitor is sent nowhere — which, again, is a thing you cannot see signed in.
  const screen = await import("./sign-in");
  expect(screen.role).toBe("sign-in");
});

test("a provider comes back to the same place, so the two ways in cannot drift apart", async () => {
  expect(CANARY_CALLBACK).not.toBe("/callback");
  issued.length = 0;

  const { SignInScreen } = await import("./sign-in");
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(<SignInScreen auth={AUTH} origin={ORIGIN} />);
  });

  const provider = host.querySelector("button[aria-label]");
  expect(provider, "no provider button rendered").not.toBeNull();
  await act(async () => {
    provider?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  expect(issued).toEqual([`${ORIGIN}${CANARY_CALLBACK}`]);
});
