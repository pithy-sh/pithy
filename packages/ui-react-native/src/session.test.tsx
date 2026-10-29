// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { AUTH_DISABLED } from "@pithy-sh/ui-core/src/config";
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

beforeEach(() => {
  calls = [];
  sessionBody = { user: { id: "u1", email: "ada@example.com" }, session: { expiresAt: "2999-01-01T00:00:00Z" } };
  vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    const body = url.endsWith("/get-session") ? sessionBody : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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

  test("sign-out tells the Worker first, then forgets the credential", async () => {
    const session = await load("ios");
    await session.adoptSignIn({ token: "raw-token" });
    await session.signOut();
    expect(calls.at(-1)?.url).toBe(`${ORIGIN}/auth/sign-out`);
    expect(calls.at(-1)?.init.headers?.authorization).toBe("Bearer raw-token");
    expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
  });

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
