// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Signing out of the React template: the session is an httpOnly cookie only the Worker can clear, so a sign-out
 * has ended it only when the Worker took it and a read then answers nobody. Until then the person stays where
 * they are, signed in, and the screen says so.
 */

vi.mock("../templates/src/pithy-config", async (importOriginal) => {
  const config = await importOriginal<typeof import("../templates/src/pithy-config")>();
  return { ...config, authConfig: { ...config.authConfig, enabled: true } };
});

const SIGN_IN_CANARY = "/canary-sign-in";
vi.mock("../templates/src/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/router")>()),
  routeTable: async () => ({ byRole: new Map([["sign-in", SIGN_IN_CANARY]]) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** How a route answers instead of its usual 200: a status with the kit's refusal for it, or no answer at all. */
type Refusal = 401 | 503 | "unreachable";

let calls: string[] = [];
let refusals: { "sign-out"?: Refusal; "get-session"?: Refusal } = {};
let signedIn = true;
/** Whether a sign-out the Worker accepts leaves the session the next read answers with. */
let sessionOutlivesSignOut = false;
let assign: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function refuse(refusal: Refusal): Response {
  if (refusal === "unreachable") throw new TypeError("Failed to fetch");
  const code = refusal === 401 ? "auth/invalid_token" : "core/internal";
  return json({ error: { code, message: "Refused." } }, refusal);
}

beforeEach(() => {
  calls = [];
  refusals = {};
  signedIn = true;
  sessionOutlivesSignOut = false;
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("/sign-out")) {
      if (refusals["sign-out"]) return refuse(refusals["sign-out"]);
      if (!sessionOutlivesSignOut) signedIn = false;
      return json({ success: true });
    }
    if (url.endsWith("/get-session")) {
      if (refusals["get-session"]) return refuse(refusals["get-session"]);
      return json(signedIn ? { user: { id: "u1", email: "ada@example.com" } } : null);
    }
    return json({});
  });
  assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign as unknown as (url: string | URL) => void);
});

let mounted: { container: HTMLElement; unmount: () => void } | null = null;

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return container;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signOut", () => {
  test("has ended the session when the Worker took it and a read then answers nobody", async () => {
    const { signOut } = await import("../templates/src/session");
    expect(await signOut()).toBe(true);
    expect(calls).toEqual(["/auth/sign-out", "/auth/get-session"]);
  });

  test("has ended it when the Worker refuses for want of a session, once a read answers nobody", async () => {
    refusals["sign-out"] = 401;
    signedIn = false;
    const { signOut } = await import("../templates/src/session");
    expect(await signOut()).toBe(true);
  });

  test.each([503, "unreachable"] as const)(
    "has not ended it when the Worker answers %s, whatever a read says",
    async (refusal) => {
      refusals["sign-out"] = refusal;
      signedIn = false;
      const { signOut } = await import("../templates/src/session");
      expect(await signOut()).toBe(false);
    },
  );

  test("has not ended it while a read still answers a session", async () => {
    sessionOutlivesSignOut = true;
    const { signOut } = await import("../templates/src/session");
    expect(await signOut()).toBe(false);
  });

  test.each([503, "unreachable"] as const)("takes a read that answers %s as no answer", async (refusal) => {
    refusals["get-session"] = refusal;
    const { signOut } = await import("../templates/src/session");
    expect(await signOut()).toBe(false);
  });

  test("leaves nothing to navigation: it only answers", async () => {
    const { signOut } = await import("../templates/src/session");
    await signOut();
    expect(assign).not.toHaveBeenCalled();
  });
});

/** The screens that sign out, each rendering the hook's failure through its own English. */
const SCREENS = {
  home: () => import("../templates/src/routes/app/home"),
  "account-suspended": () => import("../templates/src/routes/pithy/account-suspended"),
  "account-deleted": () => import("../templates/src/routes/pithy/account-deleted"),
} as const;

describe.each(Object.entries(SCREENS))("signing out of the %s screen", (_name, load) => {
  async function press(): Promise<HTMLElement> {
    const { default: Screen } = (await load()) as { default: ComponentType };
    const container = await render(<Screen />);
    const button = [...container.querySelectorAll("button")].find((each) => each.textContent === "Sign out");
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    return container;
  }

  test("that ended the session leaves for sign-in by a document load", async () => {
    const container = await press();
    expect(assign).toHaveBeenCalledWith(SIGN_IN_CANARY);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test.each([503, "unreachable"] as const)("the Worker answers %s for stays put and says so", async (refusal) => {
    refusals["sign-out"] = refusal;
    const container = await press();
    expect(assign).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "We couldn't sign you out, so you're still signed in. Try again.",
    );
    expect(container.querySelector("button")?.disabled).toBe(false);
  });
});
