// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { AUTH_DISABLED } from "@pithy-sh/ui-core/src/config";
import type { RouteModule } from "@pithy-sh/ui-core/src/routes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, Suspense } from "react";
import { AppState, type AppStateStatus, Platform, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { iap } from "../testing/expo-iap";
import { secureStore } from "../testing/expo-secure-store";
import { webBrowser } from "../testing/expo-web-browser";

const config = vi.hoisted(() => ({
  payments: {} as Record<string, unknown>,
  rails: {} as Record<string, string>,
}));

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  authConfig: { ...AUTH_DISABLED, enabled: true },
  get paymentsConfig() {
    return config.payments;
  },
  get platformRails() {
    return config.rails;
  },
}));

vi.mock("../templates/src/route-modules", () => {
  const screen = (path: string, role: string) => async () =>
    ({ path, role, default: () => <Text>{path}</Text> }) as unknown as RouteModule;
  return {
    pithyRoutes: [screen("/subscription", "subscription"), screen("/paywall", "paywall")],
    appRoutes: [],
    sessionModule: undefined,
    paymentsModule: undefined,
  };
});

const ORIGIN = "http://localhost:8787";

const PRODUCTS = [
  {
    id: "pro",
    type: "non_consumable",
    entitlements: ["pro"],
    name: "Pro",
    skus: { apple: "pro.ios", google: "pro.android", stripe: "price_1", lemonSqueezy: null, paddle: null },
  },
  {
    id: "coins",
    type: "consumable",
    entitlements: ["coins"],
    name: "Coins",
    skus: { apple: "coins.ios", google: null, stripe: null, lemonSqueezy: null, paddle: null },
  },
];

const PURCHASE_VIEW = {
  id: "p-1",
  rail: "stripe",
  productId: "pro",
  type: "non_consumable",
  status: "active",
  environment: "sandbox",
  purchasedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  resumesAt: null,
  outcome: "created",
};

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
let granted: { key: string; granted: boolean; expiresAt: null }[] = [];

beforeEach(() => {
  calls = [];
  granted = [];
  secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "raw-token", expiresAt: null }));
  config.payments = {
    enabled: true,
    environment: "dev",
    rails: { apple: true, google: true, stripe: true, lemonSqueezy: false, paddle: false },
    basePath: "/payments",
    paddle: null,
    products: PRODUCTS,
  };
  config.rails = { ios: "apple", android: "google", web: "stripe" };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    let body: unknown = {};
    if (url.endsWith("/get-session")) body = { user: { id: "user-ada", email: "ada@example.com" } };
    else if (url.endsWith("/entitlements")) body = { entitlements: granted };
    else if (url.endsWith("/checkout")) body = { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_1" };
    else if (url.endsWith("/purchases") || url.endsWith("/restore"))
      body = { purchase: PURCHASE_VIEW, purchases: [PURCHASE_VIEW], entitlements: granted };
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

async function mount(platform: "ios" | "android" | "web", at = "/paywall"): Promise<void> {
  Platform.OS = platform;
  const paywall = await import("../templates/src/routes/pithy/paywall");
  const { createMemoryAdapter, RouterProvider } = await import("../templates/src/router");
  await act(async () => {
    render(
      <StrictMode>
        <RouterProvider adapter={createMemoryAdapter(at)}>
          <Suspense fallback={null}>
            <paywall.default />
          </Suspense>
        </RouterProvider>
      </StrictMode>,
    );
  });
}

const buttons = (): string[] => screen.queryAllByRole("button").map((button) => button.textContent ?? "");
const posted = (path: string): Call[] => calls.filter((call) => call.url.endsWith(path));

describe("the paywall", () => {
  test("claims its path, its role and a session", async () => {
    const paywall = await import("../templates/src/routes/pithy/paywall");
    expect([paywall.path, paywall.role, paywall.session]).toEqual(["/paywall", "paywall", "required"]);
  });

  test("on an iPhone, sells through the App Store and offers Restore Purchases", async () => {
    await mount("ios");
    expect(buttons()).toEqual(["Buy Pro", "Buy Coins", "Restore purchases"]);
  });

  test("on the web, a product sold only in the stores is named and not sold", async () => {
    await mount("web");
    expect(buttons()).toEqual(["Buy Pro"]);
    expect(screen.getByText("Available in the app.")).toBeTruthy();
  });

  test("a consumable bought in the store is consumed once the Worker has it, and the reader is told they are set", async () => {
    await mount("ios");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Coins" }));
    });
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    const purchase = {
      id: "t1",
      productId: "coins.ios",
      platform: "ios" as const,
      purchaseState: "purchased",
      purchaseToken: "jws",
      appAccountToken: (iap.requests[0] as { request: { apple: { appAccountToken: string } } }).request.apple
        .appAccountToken,
    };
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("You're set."));
    expect(iap.finished).toEqual([{ purchase, isConsumable: true }]);
  });

  test("Restore Purchases submits what the store holds for this account, then finishes it", async () => {
    const held = {
      id: "t1",
      productId: "pro.ios",
      platform: "ios" as const,
      purchaseState: "purchased",
      purchaseToken: "jws-held",
    };
    iap.available = [held];
    granted = [{ key: "pro", granted: true, expiresAt: null }];
    await mount("ios");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore purchases" }));
    });
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("You're set."));
    expect(iap.restores).toBe(1);
    expect(posted("/restore")[0]?.url).toBe(`${ORIGIN}/payments/restore`);
    expect(JSON.parse(String(posted("/restore")[0]?.init.body))).toEqual({ rail: "apple", receipts: ["jws-held"] });
    expect(iap.finished).toEqual([{ purchase: held, isConsumable: false }]);
  });

  test("on Android, Restore Purchases sends Play's purchases verbatim, fifty to a request", async () => {
    iap.available = Array.from({ length: 51 }, (_, index) => ({
      id: `t${index}`,
      productId: "pro.android",
      platform: "android" as const,
      purchaseState: "purchased",
      purchaseToken: `tok-${index}`,
      dataAndroid: `{"orderId":"GPA.${index}","productId":"pro.android","purchaseToken":"tok-${index}"}`,
    }));
    granted = [{ key: "pro", granted: true, expiresAt: null }];
    await mount("android");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore purchases" }));
    });
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("You're set."));
    const bodies = posted("/restore").map(
      (call) => JSON.parse(String(call.init.body)) as { rail: string; receipts: string[] },
    );
    expect(bodies.map((body) => [body.rail, body.receipts.length])).toEqual([
      ["google", 50],
      ["google", 1],
    ]);
    expect(bodies[0]?.receipts[0]).toBe(iap.available[0]?.dataAndroid);
    expect(iap.finished).toHaveLength(51);
  });

  test("a restore that grants nothing sold here says so, and keeps the paywall up", async () => {
    iap.available = [
      {
        id: "t9",
        productId: "legacy.ios",
        platform: "ios" as const,
        purchaseState: "purchased",
        purchaseToken: "jws-old",
      },
    ];
    granted = [{ key: "legacy", granted: true, expiresAt: null }];
    await mount("ios");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore purchases" }));
    });
    await waitFor(() =>
      expect(screen.getByText("Your purchases are restored. None of them includes what's sold here.")).toBeTruthy(),
    );
    expect(screen.getByRole("heading").textContent).toBe("Go further.");
  });

  test("a restore with nothing in the store says so and sends nothing", async () => {
    await mount("ios");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore purchases" }));
    });
    await waitFor(() => expect(screen.getByText("The store has nothing to restore for this account.")).toBeTruthy());
    expect(posted("/restore")).toEqual([]);
  });

  test("a web rail on a phone checks out in the system browser and sees the purchase land on the way back", async () => {
    config.rails = { ios: "stripe", android: "google", web: "stripe" };
    let change: (state: AppStateStatus) => void = () => undefined;
    vi.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      change = listener as (state: AppStateStatus) => void;
      return { remove: () => undefined };
    });
    await mount("ios");
    expect(buttons()).toEqual(["Buy Pro"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitFor(() => expect(webBrowser.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_1"]));
    expect(screen.getByRole("heading").textContent).toBe("Go further.");

    granted = [{ key: "pro", granted: true, expiresAt: null }];
    await act(async () => {
      change("background");
      change("active");
    });
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("You're set."));
  });

  test("the return from Stripe posts its session exactly once under StrictMode", async () => {
    await mount("web", "/paywall?session=cs_test_1");
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("You're set."));
    expect(posted("/purchases")).toHaveLength(1);
    expect(JSON.parse(String(posted("/purchases")[0]?.init.body))).toEqual({ rail: "stripe", receipt: "cs_test_1" });
  });

  test("on a phone, the return from Stripe arrives as a universal link and posts its session with the bearer", async () => {
    const { expoRouter } = await import("../testing/expo-router");
    expoRouter.visit("/paywall?session=cs_live_9");
    secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "raw-token", expiresAt: null }));
    Platform.OS = "ios";
    const paywall = await import("../templates/src/routes/pithy/paywall");
    const { RouterProvider, useExpoRouterAdapter } = await import("../templates/src/router");
    function App(): ReactNode {
      return (
        <RouterProvider adapter={useExpoRouterAdapter()}>
          <Suspense fallback={null}>
            <paywall.default />
          </Suspense>
        </RouterProvider>
      );
    }
    await act(async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("You're set."));
    expect(posted("/purchases")).toHaveLength(1);
    expect(posted("/purchases")[0]?.url).toBe(`${ORIGIN}/payments/purchases`);
    expect(posted("/purchases")[0]?.init.credentials).toBe("omit");
    expect((posted("/purchases")[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer raw-token",
    );
    expect(JSON.parse(String(posted("/purchases")[0]?.init.body))).toEqual({ rail: "stripe", receipt: "cs_live_9" });
  });

  test("an ordinary visit posts nothing", async () => {
    await mount("web");
    expect(posted("/purchases")).toEqual([]);
  });

  test("a build that sells nothing shows each plan and what it includes, with no button and no link", async () => {
    config.rails = { ios: "none", android: "none", web: "none" };
    await mount("ios");
    expect(screen.getByText("pro")).toBeTruthy();
    expect(buttons()).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  test("with payments not composed, says there is nothing for sale", async () => {
    config.payments = { enabled: false };
    await mount("ios");
    expect(screen.getByRole("heading").textContent).toBe("Nothing for sale.");
  });
});
