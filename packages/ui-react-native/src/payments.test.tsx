// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { secureStore } from "../testing/expo-secure-store";
import { webBrowser } from "../testing/expo-web-browser";

const config = vi.hoisted(() => ({
  payments: {
    enabled: true,
    environment: "dev",
    rails: { apple: true, google: true, stripe: true, lemonSqueezy: false, paddle: false },
    basePath: "/payments",
    paddle: null,
    products: [],
  } as Record<string, unknown>,
  rails: { ios: "apple", android: "google", web: "stripe" } as Record<string, string>,
}));

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  get paymentsConfig() {
    return config.payments;
  },
  get platformRails() {
    return config.rails;
  },
}));

const ORIGIN = "http://localhost:8787";
let calls: { url: string; init: RequestInit & { headers?: Record<string, string> } }[] = [];
let entitlements: unknown = [];

beforeEach(() => {
  calls = [];
  entitlements = [{ key: "pro", granted: true, expiresAt: null }];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit & { headers?: Record<string, string> }) => {
    calls.push({ url, init });
    const body = url.endsWith("/entitlements") ? { entitlements } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  config.payments = { ...config.payments, enabled: true };
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function load(platform: "ios" | "android" | "web") {
  Platform.OS = platform;
  return import("../templates/src/payments");
}

const product = {
  skus: { apple: "pro.ios", google: "pro.android", stripe: "price_1", lemonSqueezy: null, paddle: null },
};

describe("how a product sells here", () => {
  test("in the app through the platform's own store on a phone, on a hosted page on the web", async () => {
    expect((await load("ios")).purchasePath(product)).toEqual({ kind: "store", rail: "apple", sku: "pro.ios" });
    vi.resetModules();
    expect((await load("android")).purchasePath(product)).toEqual({
      kind: "store",
      rail: "google",
      sku: "pro.android",
    });
    vi.resetModules();
    expect((await load("web")).purchasePath(product)).toEqual({ kind: "hosted", rail: "stripe" });
  });

  test("a web rail set on a phone opens its hosted page in the system browser", async () => {
    config.rails = { ios: "stripe", android: "google", web: "stripe" };
    const payments = await load("ios");
    expect(payments.purchasePath(product)).toEqual({ kind: "hosted", rail: "stripe" });
    payments.paymentsClient.navigate?.("https://checkout.stripe.com/c/pay/cs_1");
    await Promise.resolve();
    expect(webBrowser.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_1"]);
    config.rails = { ios: "apple", android: "google", web: "stripe" };
  });

  test("none sells nothing", async () => {
    config.rails = { ios: "none", android: "google", web: "stripe" };
    expect((await load("ios")).purchasePath(product)).toEqual({ kind: "none" });
    config.rails = { ios: "apple", android: "google", web: "stripe" };
  });
});

describe("the entitlement guard's answer", () => {
  test("on a phone the read carries the bearer to the Worker's origin", async () => {
    const payments = await load("ios");
    expect(await payments.holdsEntitlement("pro")).toBe(true);
    expect(calls.at(-1)?.url).toBe(`${ORIGIN}/payments/entitlements`);
    expect(calls.at(-1)?.init.credentials).toBe("omit");
  });

  test("on the web it is a relative read with the cookie", async () => {
    const payments = await load("web");
    expect(await payments.holdsEntitlement("pro")).toBe(true);
    expect(calls.at(-1)?.url).toBe("/payments/entitlements");
  });

  test("a key not granted, or a failed read, fails shut; payments not composed lets everyone through", async () => {
    const payments = await load("web");
    expect(await payments.holdsEntitlement("team")).toBe(false);
    entitlements = "garbage";
    expect(await payments.holdsEntitlement("pro")).toBe(false);
    config.payments = { enabled: false };
    vi.resetModules();
    expect(await (await load("web")).holdsEntitlement("pro")).toBe(true);
  });
});

describe("a store purchase's account token", () => {
  test("is a random v4 UUID, kept per user on this device, and never the user id", async () => {
    const payments = await load("ios");
    const ada = await payments.accountToken("user:ada");
    expect(ada).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await payments.accountToken("user:ada")).toBe(ada);
    const grace = await payments.accountToken("user:grace");
    expect(grace).not.toBe(ada);
    expect([...secureStore.items.values()]).toEqual(expect.arrayContaining([ada, grace]));
    expect([...secureStore.items.keys()].every((key) => /^[\w.-]+$/.test(key))).toBe(true);
  });

  test("two ids that differ only in characters the store cannot hold keep two tokens", async () => {
    const payments = await load("ios");
    expect(await payments.accountToken("a:b")).not.toBe(await payments.accountToken("a/b"));
  });

  test("is null on the web, and when the store cannot keep one", async () => {
    expect(await (await load("web")).accountToken("u1")).toBeNull();
    vi.resetModules();
    secureStore.failing = true;
    expect(await (await load("ios")).accountToken("u1")).toBeNull();
  });
});

describe("coming back to the app", () => {
  test("reads again when the app returns to the foreground, and not before", async () => {
    let change: (state: AppStateStatus) => void = () => undefined;
    const remove = vi.fn();
    vi.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      change = listener as (state: AppStateStatus) => void;
      return { remove };
    });
    const { useAppFocus } = await import("../templates/src/useAppFocus");
    const onActive = vi.fn();
    function Screen(): ReactNode {
      useAppFocus(onActive);
      return null;
    }
    const { unmount } = render(<Screen />);
    expect(onActive).not.toHaveBeenCalled();
    change("background");
    change("active");
    change("active");
    expect(onActive).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalled();
  });
});
