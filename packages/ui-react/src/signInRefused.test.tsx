// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ACCOUNT_DELETED, ACCOUNT_SUSPENDED } from "@pithy-sh/auth/src/client/lifecycle";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { routeTable, screenPath } from "../templates/src/router";
import { SignInScreen } from "../templates/src/routes/pithy/sign-in";

/**
 * A social sign-in the Worker refused for the account's standing comes back to the sign-in screen as `?error=`, and
 * the screen renders a redirect to that state's screen rather than a form that cannot help.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH = {
  basePath: "/auth",
  providers: { google: true, github: false, apple: false, facebook: false, microsoft: false },
  signUpEnabled: true,
};

beforeAll(async () => {
  await routeTable();
}, 120_000);

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

/** Land on the sign-in screen carrying `error`, and say whether a form was drawn before it left. */
async function land(error: string): Promise<boolean> {
  window.history.replaceState(null, "", `/sign-in?error=${encodeURIComponent(error)}`);
  const container = document.createElement("div");
  let drawn = false;
  const watch = (): void => {
    if (window.location.pathname === "/sign-in" && container.querySelector("form") !== null) drawn = true;
  };
  const observer = new MutationObserver(watch);
  observer.observe(container, { childList: true, subtree: true });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <SignInScreen auth={AUTH} origin="https://app.example" />
      </Suspense>,
    );
  });
  const deadline = Date.now() + 10_000;
  while (window.location.pathname === "/sign-in" && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  observer.disconnect();
  await act(async () => root.unmount());
  return drawn;
}

describe("the sign-in screen, landed on with an account refusal", () => {
  test("a suspended account goes on to the suspended screen and draws no form", async () => {
    const drawn = await land(ACCOUNT_SUSPENDED);
    expect(window.location.pathname).toBe(screenPath(await routeTable(), "account-suspended"));
    expect(drawn).toBe(false);
  }, 30_000);

  test("a deleted account goes on to the deleted screen", async () => {
    await land(ACCOUNT_DELETED);
    expect(window.location.pathname).toBe(screenPath(await routeTable(), "account-deleted"));
  }, 30_000);
});
