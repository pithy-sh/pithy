// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { webBrowser } from "../testing/expo-web-browser";

const ORIGIN = "http://localhost:8787";
const OFF = { apple: false, google: false, stripe: false, lemonSqueezy: false, paddle: false };

let calls: { url: string; init: RequestInit }[] = [];
let entitlements: unknown[] = [];

beforeEach(() => {
  calls = [];
  entitlements = [{ key: "pro", granted: true, expiresAt: null }];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = url.endsWith("/portal")
      ? { url: "https://billing.stripe.com/p/session/abc" }
      : { entitlements, quotas: {}, features: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function mount(
  platform: "ios" | "android" | "web",
  props: { rails?: Partial<typeof OFF>; choice?: "apple" | "google" | "stripe" | "paddle" | "none" } = {},
) {
  Platform.OS = platform;
  const subscription = await import("../templates/src/routes/pithy/subscription");
  const { createMemoryAdapter, RouterProvider } = await import("../templates/src/router");
  await act(async () => {
    render(
      <RouterProvider adapter={createMemoryAdapter("/subscription")}>
        <subscription.SubscriptionScreen
          rails={{ ...OFF, ...props.rails }}
          choice={props.choice ?? "stripe"}
          paywallPath="/paywall"
        />
      </RouterProvider>,
    );
  });
  await waitFor(() => expect(screen.queryByText("One moment.")).toBeNull());
  return subscription;
}

const buttons = (): string[] => screen.queryAllByRole("button").map((button) => button.textContent ?? "");

describe("the subscription screen", () => {
  test("claims its path, its role and a session", async () => {
    const subscription = await import("../templates/src/routes/pithy/subscription");
    expect([subscription.path, subscription.role, subscription.session]).toEqual([
      "/subscription",
      "subscription",
      "required",
    ]);
  });

  test("names what the account holds, and says so when the read failed rather than claiming nothing", async () => {
    await mount("web");
    expect(screen.getByRole("heading").textContent).toBe("You're subscribed.");
    expect(screen.getByText("Yours to keep.")).toBeTruthy();
    cleanup();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    await mount("web");
    expect(screen.getByRole("heading").textContent).toBe("We couldn't check.");
  });

  test("on a phone, the portal opens in the system browser and the subscription is read again on the way back", async () => {
    await mount("ios", { rails: { stripe: true } });
    const reads = (): number => calls.filter((call) => call.url.endsWith("/entitlements")).length;
    expect(calls[0]?.url).toBe(`${ORIGIN}/payments/entitlements`);
    const before = reads();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
    });
    await waitFor(() => expect(webBrowser.opened).toEqual(["https://billing.stripe.com/p/session/abc"]));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  test("reads again when the app comes back to the foreground", async () => {
    let change: (state: AppStateStatus) => void = () => undefined;
    vi.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      change = listener as (state: AppStateStatus) => void;
      return { remove: () => undefined };
    });
    await mount("android", { choice: "google", rails: { google: true } });
    const before = calls.length;
    await act(async () => {
      change("background");
      change("active");
    });
    await waitFor(() => expect(calls.length).toBe(before + 1));
  });

  test("a store subscription is managed on the store's own page", async () => {
    await mount("ios", { choice: "apple", rails: { apple: true } });
    expect(buttons()).toEqual(["Bought on the App Store"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Bought on the App Store" }));
    });
    await waitFor(() => expect(webBrowser.opened).toEqual(["https://apps.apple.com/account/subscriptions"]));
  });

  test("offers exactly one billing button when several hosted rails are on, and a link to the paywall", async () => {
    await mount("web", { rails: { stripe: true, paddle: true, lemonSqueezy: true } });
    expect(buttons()).toEqual(["Manage billing"]);
    expect(screen.getByRole("link").textContent).toBe("See what else there is");
  });

  test("a build that sells nothing shows what the account holds, and no button or link", async () => {
    await mount("ios", { choice: "none", rails: { apple: true, stripe: true } });
    expect(screen.getByText("pro")).toBeTruthy();
    expect(buttons()).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
  });
});
