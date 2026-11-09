// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { AUTH_DISABLED } from "@pithy-sh/ui-core/src/config";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linking } from "../testing/expo-linking";
import { secureStore } from "../testing/expo-secure-store";
import { webBrowser } from "../testing/expo-web-browser";

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  authConfig: { ...AUTH_DISABLED, enabled: true },
}));

const ORIGIN = "http://localhost:8787";

interface Call {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}

let calls: Call[] = [];
let sessionBody: unknown = null;

/** How a route answers instead of its usual 200: a status with the kit's refusal for it, or no answer at all. */
type Refusal = 401 | 503 | "unreachable";
let refusals: { "sign-out"?: Refusal; "get-session"?: Refusal } = {};
/** Whether a sign-out the Worker accepts leaves the session the next read answers with. */
let sessionOutlivesSignOut = false;

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
  sessionOutlivesSignOut = false;
  sessionBody = { user: { id: "u1", email: "ada@example.com" }, session: { expiresAt: "2999-01-01T00:00:00Z" } };
  vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    if (url.endsWith("/sign-out")) {
      if (refusals["sign-out"]) return refuse(refusals["sign-out"]);
      if (!sessionOutlivesSignOut) sessionBody = null;
      return json({ success: true });
    }
    if (url.endsWith("/get-session"))
      return refusals["get-session"] ? refuse(refusals["get-session"]) : json(sessionBody);
    return json({});
  });
});

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../templates/src/route-modules");
  vi.resetModules();
});

async function load(platform: "ios" | "web") {
  Platform.OS = platform;
  return import("../templates/src/session");
}

describe("on a phone", () => {
  test("a sign-in's token is adopted into the secure store, and the session is read with it", async () => {
    const session = await load("ios");
    expect(await session.adoptSignIn({ token: "raw-token", user: { id: "u1" } })).toBe(true);
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("raw-token");
    const read = calls.at(-1);
    expect(read?.url).toBe(`${ORIGIN}/auth/get-session`);
    expect(read?.init.headers?.authorization).toBe("Bearer raw-token");
    expect(read?.init.credentials).toBe("omit");
  });

  test("an answer with no token is a sign-in that did not take", async () => {
    const session = await load("ios");
    expect(await session.adoptSignIn({ user: { id: "u1" } })).toBe(false);
    expect(await session.adoptSignIn(null)).toBe(false);
    expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
  });

  test("on launch the stored credential is restored before the session is read", async () => {
    const first = await load("ios");
    await first.adoptSignIn({ token: "raw-token" });
    vi.resetModules();
    calls = [];
    const relaunched = await load("ios");
    expect((await relaunched.getSession())?.user.email).toBe("ada@example.com");
    expect(calls[0]?.init.headers?.authorization).toBe("Bearer raw-token");
  });

  test("sign-out tells the Worker first, then forgets the credential, and the session has ended", async () => {
    const session = await load("ios");
    await session.adoptSignIn({ token: "raw-token" });
    expect(await session.signOut()).toBe(true);
    expect(calls.at(-1)?.url).toBe(`${ORIGIN}/auth/sign-out`);
    expect(calls.at(-1)?.init.headers?.authorization).toBe("Bearer raw-token");
    expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
  });

  test.each([503, "unreachable"] as const)(
    "a sign-out the Worker answers with %s still forgets the credential, so the session has ended here",
    async (refusal) => {
      const session = await load("ios");
      await session.adoptSignIn({ token: "raw-token" });
      refusals["sign-out"] = refusal;
      expect(await session.signOut()).toBe(true);
      expect(calls.at(-1)?.url).toBe(`${ORIGIN}/auth/sign-out`);
      expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
    },
  );

  test("resuming after a sign-in opens the Worker's page in the system browser", async () => {
    const session = await load("ios");
    expect(await session.resumeAfterSignIn("?resume=%2Fauth%2Foauth2%2Fauthorize%3Fx%3D1")).toBe(true);
    expect(webBrowser.opened).toEqual([`${ORIGIN}/auth/oauth2/authorize?x=1`]);
  });
});

describe("on the web", () => {
  test("the session is the cookie: relative calls, nothing adopted, nothing stored", async () => {
    const session = await load("web");
    expect(await session.adoptSignIn({})).toBe(true);
    expect((await session.getSession())?.user.email).toBe("ada@example.com");
    expect(calls.at(-1)?.url).toBe("/auth/get-session");
    expect(calls.at(-1)?.init.credentials).toBe("include");
    expect(secureStore.items.size).toBe(0);
  });

  test("sign-out has ended the session when the Worker took it and a read then answers nobody", async () => {
    const session = await load("web");
    expect(await session.signOut()).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["/auth/sign-out", "/auth/get-session"]);
    expect(calls.every((call) => call.init.credentials === "include")).toBe(true);
  });

  test("a sign-out the Worker refuses for want of a session has ended it, once a read answers nobody", async () => {
    refusals["sign-out"] = 401;
    sessionBody = null;
    const session = await load("web");
    expect(await session.signOut()).toBe(true);
  });

  test.each([503, "unreachable"] as const)(
    "a sign-out the Worker answers with %s has not ended the session, whatever a read says",
    async (refusal) => {
      refusals["sign-out"] = refusal;
      sessionBody = null;
      const session = await load("web");
      expect(await session.signOut()).toBe(false);
    },
  );

  test("a sign-out the Worker took has not ended the session while a read still answers one", async () => {
    sessionOutlivesSignOut = true;
    const session = await load("web");
    expect(await session.signOut()).toBe(false);
  });

  test.each([503, "unreachable"] as const)(
    "a read that answers %s after the sign-out is no answer, so the session has not ended",
    async (refusal) => {
      refusals["get-session"] = refusal;
      const session = await load("web");
      expect(await session.signOut()).toBe(false);
    },
  );

  test("a Worker that answers nobody reads as signed out", async () => {
    sessionBody = null;
    const session = await load("web");
    expect(await session.getSession()).toBeNull();
  });

  // `expo-linking` drops a target, and React Native Web opens a one-argument link in a new tab, which a popup
  // blocker stops after an await. React Native's own `Linking` takes `_self`.
  test("resuming loads the Worker's page in this tab", async () => {
    const session = await load("web");
    const { Linking } = await import("react-native");
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    expect(await session.resumeAfterSignIn("?resume=%2Fauth%2Foauth2%2Fauthorize")).toBe(true);
    expect(open).toHaveBeenCalledWith("/auth/oauth2/authorize", "_self");
    expect(linking.opened).toEqual([]);
  });

  test("leaving for a provider's page stays in this tab", async () => {
    const session = await load("web");
    const { Linking } = await import("react-native");
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await session.leaveInPlace("https://github.com/login/oauth/authorize?state=s");
    expect(open).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=s", "_self");
    expect(linking.opened).toEqual([]);
  });
});

describe("a sign-in that resumes on one of the app's own screens", () => {
  /** Register one screen, the invitation's, so the resume target is a path the router answers. */
  function registerInvitation(): void {
    vi.doMock("../templates/src/route-modules", () => ({
      pithyRoutes: [async () => ({ path: "/invitations/:token", default: () => null })],
      appRoutes: [],
      sessionModule: undefined,
      paymentsModule: undefined,
    }));
  }

  test("on a phone, goes there in the app rather than opening the Worker in a browser", async () => {
    registerInvitation();
    const session = await load("ios");
    const go = vi.fn();
    expect(await session.resumeAfterSignIn("?resume=%2Finvitations%2Ftok_1", go)).toBe(true);
    expect(go).toHaveBeenCalledWith("/invitations/tok_1");
    expect(webBrowser.opened).toEqual([]);
  });

  test("on the web, goes there in the app too", async () => {
    registerInvitation();
    const session = await load("web");
    const go = vi.fn();
    expect(await session.resumeAfterSignIn("?resume=%2Finvitations%2Ftok_1", go)).toBe(true);
    expect(go).toHaveBeenCalledWith("/invitations/tok_1");
    expect(linking.opened).toEqual([]);
  });

  test("a Worker page is still the Worker's, whatever the app registers", async () => {
    registerInvitation();
    const session = await load("ios");
    const go = vi.fn();
    expect(await session.resumeAfterSignIn("?resume=%2Fauth%2Foauth2%2Fauthorize", go)).toBe(true);
    expect(go).not.toHaveBeenCalled();
    expect(webBrowser.opened).toEqual([`${ORIGIN}/auth/oauth2/authorize`]);
  });
});

describe("where a sign-in resumes", () => {
  test("only a path on the Worker's own origin", async () => {
    const { resumeTarget } = await load("web");
    expect(resumeTarget("?resume=%2Fauth%2Fx")).toBe("/auth/x");
    for (const hostile of [
      "https://evil.test/",
      "//evil.test",
      "/\\evil.test",
      "/%09/evil.test",
      "/a%0d%0ab",
      "relative",
    ]) {
      expect(resumeTarget(`?resume=${encodeURIComponent(decodeURIComponent(hostile))}`), hostile).toBeNull();
    }
    expect(resumeTarget("")).toBeNull();
  });

  test("is carried onward as a query, or not at all", async () => {
    const { resumeQuery } = await load("web");
    expect(resumeQuery("?resume=%2Fauth%2Fx")).toBe("?resume=%2Fauth%2Fx");
    expect(resumeQuery("?resume=%2F%2Fevil.test")).toBe("");
  });
});

describe("a refused account", () => {
  test("is sent to the screen for its state, and any other code is left alone", async () => {
    const { refusedAccountScreen } = await load("web");
    expect(refusedAccountScreen("auth/account_suspended")).toBe("account-suspended");
    expect(refusedAccountScreen("auth/account_deleted")).toBe("account-deleted");
    expect(refusedAccountScreen("auth/invalid_token")).toBeNull();
    expect(refusedAccountScreen(null)).toBeNull();
  });
});

describe("signing out from a screen", () => {
  let mounts = 0;

  /** Register the sign-in screen, so signing out has somewhere to go. */
  function registerSignIn(): void {
    vi.doMock("../templates/src/route-modules", () => ({
      pithyRoutes: [async () => ({ path: "/sign-in", role: "sign-in", default: () => null })],
      appRoutes: [],
      sessionModule: undefined,
      paymentsModule: undefined,
    }));
  }

  /** Mount a screen that signs out through the hook, on `platform`, and hand back what it saw. */
  async function mountOn(platform: "ios" | "web") {
    registerSignIn();
    const session = await load(platform);
    const { RouterProvider, createMemoryAdapter } = await import("../templates/src/router");
    const { useEffect } = await import("react");
    const seen: { current: ReturnType<typeof session.useSignOut> | null } = { current: null };
    function Screen(): null {
      seen.current = session.useSignOut();
      useEffect(() => {
        mounts += 1;
      }, []);
      return null;
    }
    const adapter = createMemoryAdapter("/home");
    render(
      <RouterProvider adapter={adapter}>
        <Screen />
      </RouterProvider>,
    );
    await act(async () => {
      await seen.current?.run();
    });
    return { adapter, seen, session };
  }

  beforeEach(() => {
    mounts = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("on the web, a sign-out that ended the session leaves for sign-in and remounts every screen", async () => {
    const { adapter } = await mountOn("web");
    await waitFor(() => expect(adapter.path()).toBe("/sign-in"));
    expect(mounts).toBe(2);
  });

  test.each([503, "unreachable"] as const)(
    "on the web, a sign-out the Worker answers with %s stays where it is and says it did not finish",
    async (refusal) => {
      refusals["sign-out"] = refusal;
      const { adapter, seen } = await mountOn("web");
      expect(seen.current?.failure).toBeInstanceOf(Error);
      expect(seen.current?.pending).toBe(false);
      expect(adapter.path()).toBe("/home");
      expect(mounts).toBe(1);
    },
  );

  test("on a phone, a sign-out the Worker could not take still forgets the credential and leaves for sign-in", async () => {
    secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "held-session", expiresAt: null }));
    refusals["sign-out"] = 503;
    const { adapter, seen } = await mountOn("ios");
    await waitFor(() => expect(adapter.path()).toBe("/sign-in"));
    expect(seen.current?.failure).toBeNull();
    expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
  });
});
