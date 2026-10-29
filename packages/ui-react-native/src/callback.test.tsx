// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { NEUTRAL_PROVIDER_REFUSAL } from "@pithy-sh/auth/src/http/providerRefusal";
import type { RouteModule } from "@pithy-sh/ui-core/src/routes";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Platform, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linking } from "../testing/expo-linking";
import { secureStore } from "../testing/expo-secure-store";
import { webBrowser } from "../testing/expo-web-browser";

vi.mock("../templates/src/pithy-config", async (importOriginal) => {
  const { AUTH_DISABLED } = await import("@pithy-sh/ui-core/src/config");
  return {
    ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
    authConfig: { ...AUTH_DISABLED, enabled: true },
  };
});

vi.mock("../templates/src/route-modules", () => {
  const screen = (path: string, role?: string) => async () =>
    ({ path, role, default: () => <Text>{path}</Text> }) as unknown as RouteModule;
  return {
    pithyRoutes: [
      screen("/sign-in", "sign-in"),
      screen("/account-suspended", "account-suspended"),
      screen("/account-deleted", "account-deleted"),
      screen("/invitations/:token"),
    ],
    appRoutes: [screen("/")],
    sessionModule: undefined,
    paymentsModule: undefined,
  };
});

const ORIGIN = "http://localhost:8787";

interface Call {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}

let calls: Call[] = [];
let signedIn = true;
let tradeAnswer: { status: number; body: unknown } = {
  status: 200,
  body: { token: "traded", expiresAt: "2999-01-01T00:00:00Z" },
};

beforeEach(() => {
  calls = [];
  signedIn = true;
  tradeAnswer = { status: 200, body: { token: "traded", expiresAt: "2999-01-01T00:00:00Z" } };
  vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    let status = 200;
    let body: unknown = {};
    if (url.endsWith("/get-session")) body = signedIn ? { user: { id: "u1", email: "ada@example.com" } } : null;
    if (url.endsWith("/handoff")) ({ status, body } = tradeAnswer);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Land on the callback at `path`, on `platform`, with the modules read after the platform is set. */
async function land(platform: "ios" | "android" | "web", path: string) {
  Platform.OS = platform;
  const router = await import("../templates/src/router");
  const callback = await import("../templates/src/routes/pithy/callback");
  const session = await import("../templates/src/session");
  const adapter = router.createMemoryAdapter(path);
  await act(async () => {
    render(
      <router.RouterProvider adapter={adapter}>
        <callback.default />
      </router.RouterProvider>,
    );
  });
  return { adapter, session, callback };
}

describe("the callback screen", () => {
  test("sits at the path the sign-in screen builds its links from, and says what is happening", async () => {
    const { callback } = await land("web", "/callback");
    expect(callback.path).toBe("/callback");
    expect(screen.getByRole("heading").textContent).toBe("Signing you in.");
  });
});

describe("on the web, where the Worker set the cookie", () => {
  test("a session goes home", async () => {
    const { adapter } = await land("web", "/callback");
    await waitFor(() => expect(adapter.path()).toBe("/"));
  });

  test("no session goes back to sign in", async () => {
    signedIn = false;
    const { adapter } = await land("web", "/callback");
    await waitFor(() => expect(adapter.path()).toBe("/sign-in"));
  });

  test("a refusal for the account's standing goes on to the screen for it", async () => {
    const { adapter } = await land("web", "/callback?error=auth%2Faccount_deleted");
    await waitFor(() => expect(adapter.path()).toBe("/account-deleted"));
  });

  test("a resume target loads the Worker's page in this tab", async () => {
    const { Linking } = await import("react-native");
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await land("web", "/callback?resume=%2Fauth%2Foauth2%2Fauthorize");
    await waitFor(() => expect(open).toHaveBeenCalledWith("/auth/oauth2/authorize", "_self"));
    expect(linking.opened).toEqual([]);
  });
});

describe("on a phone, where the deep link carries a one-time code", () => {
  test("the code is traded with the waiting verifier, the session adopted, and the app goes home", async () => {
    Platform.OS = "ios";
    const session = await import("../templates/src/session");
    await session.beginHandoff("/callback");
    const { adapter } = await land("ios", "/callback?code=one-time");
    await waitFor(() => expect(adapter.path()).toBe("/"));
    expect(calls.filter((call) => call.url === `${ORIGIN}/auth/handoff`)).toHaveLength(1);
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("traded");
  });

  test("a code nothing on this device asked for goes back to sign in, and the Worker is never asked", async () => {
    signedIn = false;
    const { adapter } = await land("ios", "/callback?code=stray");
    await waitFor(() => expect(adapter.path()).toBe("/sign-in"));
    expect(calls.some((call) => call.url.endsWith("/handoff"))).toBe(false);
  });

  test("a trade refused for the account's standing goes on to the screen for it", async () => {
    tradeAnswer = { status: 403, body: { error: { code: "auth/account_suspended", message: "No.", action: null } } };
    Platform.OS = "ios";
    const session = await import("../templates/src/session");
    await session.beginHandoff("/callback");
    const { adapter } = await land("ios", "/callback?code=one-time");
    await waitFor(() => expect(adapter.path()).toBe("/account-suspended"));
  });

  test("a resume target opens the Worker's page in the system browser, and the app goes home", async () => {
    Platform.OS = "ios";
    const session = await import("../templates/src/session");
    await session.beginHandoff("/callback?resume=%2Fauth%2Fx");
    const { adapter } = await land("ios", "/callback?resume=%2Fauth%2Fx&code=one-time");
    await waitFor(() => expect(adapter.path()).toBe("/"));
    expect(webBrowser.opened).toEqual([`${ORIGIN}/auth/x`]);
  });

  test("a provider's refusal that returned here goes on to the sign-in screen, which says who refused", async () => {
    signedIn = false;
    const { adapter } = await land("android", `/callback?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`);
    await waitFor(() => expect(adapter.path()).toBe(`/sign-in?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`));
  });

  test("an invitation that sent somebody to sign in is where the app goes, not a browser", async () => {
    Platform.OS = "ios";
    const session = await import("../templates/src/session");
    await session.beginHandoff("/callback?resume=%2Finvitations%2Ftok_1");
    const { adapter } = await land("ios", "/callback?resume=%2Finvitations%2Ftok_1&code=one-time");
    await waitFor(() => expect(adapter.path()).toBe("/invitations/tok_1"));
    expect(webBrowser.opened).toEqual([]);
  });
});
