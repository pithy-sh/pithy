// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { GB } from "@pithy-sh/payments/src/client/fixtures/pricePreview";
import type { PaddleJs, PaddleSetup } from "@pithy-sh/payments/src/client/paddle";
import type { PaymentsClientProduct } from "@pithy-sh/payments/src/client/projection";
import type { PaymentsPurchasePath } from "@pithy-sh/payments/src/client/railChoice";
import { AUTH_DISABLED } from "@pithy-sh/ui-core/src/config";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { iap } from "../testing/expo-iap";
import { secureStore } from "../testing/expo-secure-store";
import { webBrowser } from "../testing/expo-web-browser";

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  authConfig: { ...AUTH_DISABLED, enabled: true },
}));

const ORIGIN = "http://localhost:8787";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PURCHASE_VIEW = {
  id: "p-1",
  rail: "apple",
  productId: "pro",
  type: "subscription",
  status: "active",
  environment: "sandbox",
  purchasedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  resumesAt: null,
  outcome: "created",
};

const PRO: PaymentsClientProduct = {
  id: "pro",
  type: "subscription",
  entitlements: ["pro"],
  name: "Pro",
  skus: {
    apple: "pro.ios",
    google: "pro.android",
    stripe: "price_1",
    lemonSqueezy: null,
    paddle: "pri_01kzvyz9e21z9vbhd7xqq3csyh",
  },
};

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
let answer: (url: string) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "raw-token", expiresAt: null }));
  answer = (url) => {
    if (url.endsWith("/get-session"))
      return { status: 200, body: { user: { id: "user-ada", email: "ada@example.com" } } };
    if (url.endsWith("/purchases"))
      return {
        status: 200,
        body: { purchase: PURCHASE_VIEW, entitlements: [{ key: "pro", granted: true, expiresAt: null }] },
      };
    if (url.endsWith("/checkout"))
      return { status: 200, body: { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_1" } };
    return { status: 200, body: {} };
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.resetModules();
});

interface Mount {
  path: PaymentsPurchasePath;
  signedIn?: boolean | null;
  signInPath?: string | null;
  setup?: PaddleSetup | null;
  paddle?: PaddleJs;
  products?: PaymentsClientProduct[];
}

async function mount(platform: "ios" | "android" | "web", options: Mount): Promise<void> {
  Platform.OS = platform;
  const pricing = await import("../templates/src/routes/pithy/pricing");
  const { createMemoryAdapter, RouterProvider } = await import("../templates/src/router");
  const paddle = options.paddle;
  await act(async () => {
    render(
      <RouterProvider adapter={createMemoryAdapter("/pricing")}>
        <pricing.PricingScreen
          products={options.products ?? [PRO]}
          pathFor={() => options.path}
          setup={options.setup ?? null}
          signedIn={options.signedIn === undefined ? true : options.signedIn}
          signInPath={options.signInPath === undefined ? "/a-sign-in-path-only-this-test-knows" : options.signInPath}
          subscriptionPath="/subscription"
          visitor={null}
          paddle={paddle ? { initialize: () => Promise.resolve(paddle), registry: {} } : undefined}
        />
      </RouterProvider>,
    );
  });
}

const posted = (path: string): Call[] => calls.filter((call) => call.url.endsWith(path));
const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init.body));

async function waitForRequest(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(iap.requests).toHaveLength(1));
  return iap.requests[0] as Record<string, unknown>;
}

/** The account token the last purchase asked of the store was tagged with, as the store hands it back. */
function taggedLast(): Record<string, string> {
  const request = (iap.requests.at(-1) as { request: Record<string, Record<string, string>> }).request;
  return request.apple
    ? { appAccountToken: request.apple.appAccountToken ?? "" }
    : { obfuscatedAccountIdAndroid: request.google?.obfuscatedAccountId ?? "" };
}

describe("buying through the App Store", () => {
  test("shows the store's own price, tags the purchase with a random token, and finishes it once the Worker has it", async () => {
    iap.products = [
      { id: "pro.ios", title: "Pro", displayPrice: "store-rendered price", platform: "ios", type: "subs" },
    ];
    await mount("ios", { path: { kind: "store", rail: "apple", sku: "pro.ios" } });
    await waitFor(() => expect(screen.getByText("store-rendered price")).toBeTruthy());
    expect(screen.getByText("Prices are the store's, for where you are.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    const request = await waitForRequest();
    expect(request.type).toBe("subs");
    const apple = (request.request as { apple: { sku: string; appAccountToken: string } }).apple;
    expect(apple.sku).toBe("pro.ios");
    expect(apple.appAccountToken).toMatch(UUID_V4);
    expect(apple.appAccountToken).not.toContain("user-ada");
    expect([...secureStore.items.values()]).toContain(apple.appAccountToken);
    expect(iap.finished).toEqual([]);

    const purchase = {
      id: "t1",
      productId: "pro.ios",
      platform: "ios" as const,
      purchaseState: "purchased",
      purchaseToken: "signed.jws.value",
      ...taggedLast(),
    };
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase, isConsumable: false }]));
    expect(posted("/purchases")[0]?.url).toBe(`${ORIGIN}/payments/purchases`);
    expect(bodyOf(posted("/purchases")[0])).toEqual({ rail: "apple", receipt: "signed.jws.value" });
    expect(screen.getByText("Thanks. Your purchase is on your account.")).toBeTruthy();
  });

  test("a purchase the Worker refuses is left with the store, and the refusal is shown", async () => {
    answer = (url) =>
      url.endsWith("/get-session")
        ? { status: 200, body: { user: { id: "user-ada", email: "ada@example.com" } } }
        : {
            status: 409,
            body: { error: { code: "payments/receipt_already_owned", status: 409, message: "Not yours." } },
          };
    await mount("ios", { path: { kind: "store", rail: "apple", sku: "pro.ios" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitForRequest();
    await act(async () => {
      iap.complete({
        id: "t1",
        productId: "pro.ios",
        platform: "ios",
        purchaseState: "purchased",
        purchaseToken: "jws",
        ...taggedLast(),
      });
    });
    await waitFor(() => expect(screen.getByText("Not yours.")).toBeTruthy());
    expect(iap.finished).toEqual([]);
  });

  test("closing the store's sheet is not a failure, and buys nothing", async () => {
    await mount("ios", { path: { kind: "store", rail: "apple", sku: "pro.ios" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitForRequest();
    await act(async () => {
      iap.fail({ code: "user-cancelled", message: "Cancelled." });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Buy Pro" }).getAttribute("aria-disabled")).not.toBe("true"),
    );
    expect(posted("/purchases")).toEqual([]);
    expect(screen.queryByText("The store didn't finish the purchase.")).toBeNull();
  });

  test("an error from the store is said in the screen's words", async () => {
    await mount("ios", { path: { kind: "store", rail: "apple", sku: "pro.ios" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitForRequest();
    await act(async () => {
      iap.fail({ code: "network-error", message: "offline" });
    });
    await waitFor(() => expect(screen.getByText("The store didn't finish the purchase.")).toBeTruthy());
  });

  test("a second purchase that fails takes back the thanks the first one earned", async () => {
    await mount("ios", { path: { kind: "store", rail: "apple", sku: "pro.ios" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitForRequest();
    await act(async () => {
      iap.complete({
        id: "t1",
        productId: "pro.ios",
        platform: "ios",
        purchaseState: "purchased",
        purchaseToken: "jws",
        ...taggedLast(),
      });
    });
    await waitFor(() => expect(screen.getByText("Thanks. Your purchase is on your account.")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitFor(() => expect(iap.requests).toHaveLength(2));
    await act(async () => {
      iap.fail({ code: "network-error", message: "offline" });
    });
    await waitFor(() => expect(screen.getByText("The store didn't finish the purchase.")).toBeTruthy());
    expect(screen.queryByText("Thanks. Your purchase is on your account.")).toBeNull();
  });

  test("a store that cannot be reached is said so, and nothing is asked for", async () => {
    iap.unreachable = true;
    await mount("ios", { path: { kind: "store", rail: "apple", sku: "pro.ios" } });
    expect(screen.getByText("We couldn't get a price. You'll see it at checkout.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitFor(() => expect(screen.getByText("The store didn't answer. Try again in a moment.")).toBeTruthy());
    expect(iap.requests).toEqual([]);
  });
});

describe("buying through Google Play", () => {
  test("tags the purchase as the account's, names the subscription's offer, and submits getOriginalJson verbatim", async () => {
    iap.products = [
      {
        id: "pro.android",
        title: "Pro",
        displayPrice: "play-rendered price",
        platform: "android",
        type: "subs",
        subscriptionOffers: [{ id: "base", displayPrice: "play-rendered price", offerTokenAndroid: "offer-token-1" }],
      },
    ];
    await mount("android", { path: { kind: "store", rail: "google", sku: "pro.android" } });
    await waitFor(() => expect(screen.getByText("play-rendered price")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    const request = await waitForRequest();
    const google = (request.request as { google: Record<string, unknown> }).google;
    expect(google.skus).toEqual(["pro.android"]);
    expect(google.obfuscatedAccountId).toMatch(UUID_V4);
    expect(google.subscriptionOffers).toEqual([{ sku: "pro.android", offerToken: "offer-token-1" }]);

    const originalJson = '{"orderId":"GPA.1","productId":"pro.android","purchaseToken":"tok"}';
    const purchase = {
      id: "t1",
      productId: "pro.android",
      platform: "android" as const,
      purchaseState: "purchased",
      purchaseToken: "tok",
      dataAndroid: originalJson,
      ...taggedLast(),
    };
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(iap.finished).toHaveLength(1));
    expect(bodyOf(posted("/purchases")[0])).toEqual({ rail: "google", receipt: originalJson });
  });

  test("a purchase still waiting on the store is neither submitted nor finished", async () => {
    await mount("android", { path: { kind: "store", rail: "google", sku: "pro.android" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitForRequest();
    await act(async () => {
      iap.complete({
        id: "t1",
        productId: "pro.android",
        platform: "android",
        purchaseState: "pending",
        ...taggedLast(),
      });
    });
    await waitFor(() => expect(screen.getByText(/still processing/)).toBeTruthy());
    expect(posted("/purchases")).toEqual([]);
    expect(iap.finished).toEqual([]);
  });
});

describe("a hosted rail", () => {
  test("on a phone, checkout opens in the system browser, and the price is the checkout's to show", async () => {
    await mount("ios", { path: { kind: "hosted", rail: "stripe" } });
    expect(screen.getByText("You'll see the price at checkout.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitFor(() => expect(webBrowser.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_1"]));
    expect(bodyOf(posted("/checkout")[0])).toEqual({ productId: "pro", rail: "stripe" });
  });

  test("a Paddle checkout that would open over a page is refused by name, and nothing opens", async () => {
    answer = () => ({
      status: 200,
      body: {
        kind: "paddle",
        transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
        clientToken: "test_pithyNotARealClientToken",
        environment: "sandbox",
        displayMode: "overlay",
        successUrl: "https://app.example.com/paid",
      },
    });
    await mount("ios", { path: { kind: "hosted", rail: "paddle" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy Pro" }));
    });
    await waitFor(() =>
      expect(screen.getByText("This checkout opens inside a web page, which the app can't show.")).toBeTruthy(),
    );
    expect(webBrowser.opened).toEqual([]);
  });

  test("on the web, a Paddle product is quoted by Paddle for this visitor", async () => {
    const paddle: PaddleJs = {
      Initialized: true,
      Environment: { set: () => undefined },
      PricePreview: () => Promise.resolve(GB),
      Checkout: { open: () => undefined, close: () => undefined },
    };
    await mount("web", {
      path: { kind: "hosted", rail: "paddle" },
      setup: { clientToken: "test_pithyNotARealClientToken", environment: "sandbox" },
      paddle,
    });
    await waitFor(() => expect(screen.queryByText("Getting your price.")).toBeNull());
    expect(screen.getByText("Prices are for where you are. Tax is Paddle's to calculate, not ours.")).toBeTruthy();
    expect(screen.queryByText("We couldn't get a price. You'll see it at checkout.")).toBeNull();
  });
});

describe("who is looking", () => {
  test("a stranger is offered the way in, by name, instead of a button that fails", async () => {
    await mount("ios", { path: { kind: "hosted", rail: "stripe" }, signedIn: false });
    expect(screen.getByText("Anyone can read a price. Buying needs an account.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("link", { name: "Sign in to buy Pro" })).toBeTruthy();
  });

  test("a visitor whose session is still being read cannot buy yet", async () => {
    await mount("ios", { path: { kind: "hosted", rail: "stripe" }, signedIn: null });
    expect(screen.getByRole("button", { name: "Buy Pro" }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("a build that sells nothing", () => {
  test("shows each plan and what it includes, with no price, no button and no link", async () => {
    await mount("ios", { path: { kind: "none" }, signedIn: false });
    expect(screen.getByText("Pro")).toBeTruthy();
    expect(screen.getByText("pro")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.queryByText(/price/i)).toBeNull();
    expect(iap.requests).toEqual([]);
  });

  test("nothing sellable on this platform is its own screen", async () => {
    await mount("ios", { path: { kind: "unavailable" } });
    expect(screen.getByRole("heading").textContent).toBe("Nothing priced here.");
  });
});
