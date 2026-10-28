// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, type ReactNode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { RequireEntitlement, RequireSignedIn, routeTable, screenPath } from "../templates/src/router";

/**
 * The scaffolded router's guards render a redirect from the answer, so the screen they guard is never on the page
 * on the way out, not for one frame.
 *
 * Rendered without StrictMode: its second effect pass imports the mocked module twice at once, and vitest can hand
 * the second import the original. `Redirect`'s own suite holds the one navigation under StrictMode.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answers = vi.hoisted(() => ({ session: null as unknown, held: false as boolean | ((key: string) => boolean) }));

vi.mock("../templates/src/session.tsx", () => ({ getSession: async () => answers.session }));
vi.mock("../templates/src/payments.tsx", () => ({
  holdsEntitlement: async (key: string) => (typeof answers.held === "function" ? answers.held(key) : answers.held),
}));

beforeAll(async () => {
  await routeTable();
}, 120_000);

beforeEach(() => {
  window.history.replaceState(null, "", "/guarded");
});

/** Render `tree`, record whether the guarded screen was ever committed, and wait for the answer to land. */
async function guard(tree: (child: ReactNode) => ReactNode): Promise<{ shown: boolean; html: string }> {
  let shown = false;
  function Secret(): ReactNode {
    shown = true;
    return <p>secret</p>;
  }
  const container = document.createElement("div");
  const seen = new MutationObserver(() => {
    if (container.innerHTML.includes("secret")) shown = true;
  });
  seen.observe(container, { childList: true, subtree: true, characterData: true });
  const root = createRoot(container);
  await act(async () => {
    root.render(<Suspense fallback={null}>{tree(<Secret />)}</Suspense>);
  });
  const deadline = Date.now() + 10_000;
  while (container.innerHTML.includes("One moment.") || container.innerHTML === "") {
    if (shown || window.location.pathname !== "/guarded") break;
    if (Date.now() > deadline) throw new Error("the guard never answered");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  const html = container.innerHTML;
  seen.disconnect();
  await act(async () => root.unmount());
  return { shown, html };
}

describe("RequireSignedIn", () => {
  test("a signed-out visitor goes to the sign-in screen and the guarded route never renders", async () => {
    answers.session = null;
    const pushes = vi.spyOn(window.history, "pushState");
    const { shown } = await guard((child) => <RequireSignedIn>{child}</RequireSignedIn>);
    expect(shown).toBe(false);
    expect(window.location.pathname).toBe(screenPath(await routeTable(), "sign-in"));
    expect(pushes).toHaveBeenCalledTimes(1);
    pushes.mockRestore();
  }, 30_000);

  test("a signed-in visitor sees the guarded route and goes nowhere", async () => {
    answers.session = { user: { id: "u1" } };
    const { shown, html } = await guard((child) => <RequireSignedIn>{child}</RequireSignedIn>);
    expect(shown).toBe(true);
    expect(html).toContain("secret");
    expect(window.location.pathname).toBe("/guarded");
  }, 30_000);
});

describe("RequireEntitlement", () => {
  test("a visitor without the entitlement goes to the paywall and the guarded route never renders", async () => {
    answers.held = false;
    const { shown } = await guard((child) => <RequireEntitlement entitlement="pro">{child}</RequireEntitlement>);
    expect(shown).toBe(false);
    expect(window.location.pathname).toBe(screenPath(await routeTable(), "paywall"));
  }, 30_000);

  test("a visitor holding it sees the guarded route", async () => {
    answers.held = true;
    const { shown } = await guard((child) => <RequireEntitlement entitlement="pro">{child}</RequireEntitlement>);
    expect(shown).toBe(true);
    expect(window.location.pathname).toBe("/guarded");
  }, 30_000);

  test("moving from a held entitlement to one not held never renders the new route", async () => {
    answers.held = (key) => key === "pro";
    const shown: string[] = [];
    function Screen(props: { name: string }): ReactNode {
      shown.push(props.name);
      return <p>{props.name}</p>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (entitlement: string) =>
      root.render(
        <Suspense fallback={null}>
          <RequireEntitlement entitlement={entitlement}>
            <Screen name={entitlement} />
          </RequireEntitlement>
        </Suspense>,
      );
    await act(async () => render("pro"));
    const deadline = Date.now() + 10_000;
    while (!shown.includes("pro")) {
      if (Date.now() > deadline) throw new Error("the guard never answered");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    await act(async () => render("team"));
    while (window.location.pathname === "/guarded") {
      if (Date.now() > deadline) throw new Error("the guard never redirected");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    await act(async () => root.unmount());
    expect(shown).not.toContain("team");
    expect(window.location.pathname).toBe(screenPath(await routeTable(), "paywall"));
  }, 30_000);
});
