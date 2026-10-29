// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { AUTH_DISABLED } from "@pithy-sh/ui-core/src/config";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { iap } from "../testing/expo-iap";
import { secureStore } from "../testing/expo-secure-store";

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

const ORIGIN = "http://localhost:8787";

const PURCHASE_VIEW = {
  id: "p-1",
  rail: "apple",
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
let accepts = true;
/** Who the Worker says is signed in on this device, or `null` for nobody. */
let user: string | null = "user-ada";
/** Run once the Worker is asked who is signed in, before it answers. */
let asked: (() => void) | null = null;

beforeEach(() => {
  calls = [];
  accepts = true;
  user = "user-ada";
  asked = null;
  secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "raw-token", expiresAt: null }));
  config.payments = {
    enabled: true,
    environment: "dev",
    rails: { apple: true, google: true, stripe: true, lemonSqueezy: false, paddle: false },
    basePath: "/payments",
    paddle: null,
    products: [
      {
        id: "pro",
        type: "subscription",
        entitlements: ["pro"],
        name: "Pro",
        skus: { apple: "pro.ios", google: "pro.android", stripe: null, lemonSqueezy: null, paddle: null },
      },
      {
        id: "coins",
        type: "consumable",
        entitlements: ["coins"],
        name: "Coins",
        skus: { apple: "coins.ios", google: "coins.android", stripe: null, lemonSqueezy: null, paddle: null },
      },
    ],
  };
  config.rails = { ios: "apple", android: "google", web: "stripe" };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/purchases") && !accepts)
      return new Response(
        JSON.stringify({ code: "payments/receipt_invalid", message: "That receipt didn't verify.", status: 400 }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    let body: unknown = {};
    if (url.endsWith("/get-session")) asked?.();
    if (url.endsWith("/get-session"))
      body = user === null ? null : { user: { id: user, email: `${user}@example.com` } };
    else if (url.endsWith("/purchases")) body = { purchase: PURCHASE_VIEW, entitlements: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.resetModules();
});

const submitted = (): unknown[] =>
  calls.filter((call) => call.url.endsWith("/purchases")).map((call) => JSON.parse(String(call.init.body)));

/** The listener alone, mounted the way the root layout mounts it. */
async function mountListener(platform: "ios" | "android" | "web"): Promise<() => void> {
  Platform.OS = platform;
  const { useStoreTransactions } = await import("../templates/src/useStoreTransactions");
  function Root(): ReactNode {
    useStoreTransactions();
    return null;
  }
  let unmount: () => void = () => undefined;
  await act(async () => {
    unmount = render(
      <StrictMode>
        <Root />
      </StrictMode>,
    ).unmount;
  });
  return unmount;
}

/** The account token `userId`'s purchases are tagged with on this device, as the app mints it. */
async function tokenOf(userId: string): Promise<string> {
  const { accountToken } = await import("../templates/src/payments");
  const token = await accountToken(userId);
  if (token === null) throw new Error("This device kept no account token.");
  return token;
}

/** The token Ada's purchases on this device carry. Set once the listener is mounted, on a phone. */
let ada = "";

/** Learn the account token Ada's purchases carry on `platform`. */
async function learnAda(platform: "ios" | "android"): Promise<void> {
  Platform.OS = platform;
  ada = await tokenOf("user-ada");
}

/** Mount the listener on `platform` with Ada signed in. */
async function mountAsAda(platform: "ios" | "android"): Promise<() => void> {
  await learnAda(platform);
  return mountListener(platform);
}

const delivered = (overrides: Record<string, unknown> = {}) => ({
  id: "t-launch",
  productId: "pro.ios",
  platform: "ios" as const,
  purchaseState: "purchased",
  purchaseToken: "jws-launch",
  appAccountToken: ada,
  ...overrides,
});

/** Wait until the listener is attached and the store connection is open, so the store delivers to it. */
const listening = () =>
  waitFor(() => {
    expect(iap.updated.size).toBe(1);
    expect(iap.connected).toBe(true);
  });

/** Let every pending store and Worker answer land. */
const settleAll = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

describe("purchases the store delivers with no screen waiting", () => {
  test("an interrupted purchase redelivered at launch goes to the Worker, then is finished", async () => {
    await mountAsAda("ios");
    await listening();
    const purchase = delivered();
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase, isConsumable: false }]));
    expect(submitted()).toEqual([{ rail: "apple", receipt: "jws-launch" }]);
    const sent = calls.find((call) => call.url.endsWith("/purchases"));
    expect(sent?.url).toBe(`${ORIGIN}/payments/purchases`);
    expect(sent?.init.credentials).toBe("omit");
    expect((sent?.init.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer raw-token");
  });

  test("a consumable is consumed once the Worker has it", async () => {
    await mountAsAda("ios");
    await listening();
    const purchase = delivered({ id: "t-coins", productId: "coins.ios", purchaseToken: "jws-coins" });
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase, isConsumable: true }]));
  });

  test("a purchase the Worker refuses is left with the store, unfinished", async () => {
    accepts = false;
    await mountAsAda("ios");
    await listening();
    await act(async () => {
      iap.complete(delivered());
    });
    await waitFor(() => expect(submitted()).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(iap.finished).toEqual([]);
  });

  test("an Ask to Buy request still pending sends nothing; its approval goes through", async () => {
    await mountAsAda("ios");
    await listening();
    await act(async () => {
      iap.complete(delivered({ purchaseState: "pending", purchaseToken: null }));
    });
    expect(submitted()).toEqual([]);
    const approved = delivered({ id: "t-approved", purchaseToken: "jws-approved" });
    await act(async () => {
      iap.complete(approved);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase: approved, isConsumable: false }]));
    expect(submitted()).toEqual([{ rail: "apple", receipt: "jws-approved" }]);
  });

  test("on Android, a purchase still pending carries a token and is still left alone, at launch and when delivered", async () => {
    await learnAda("android");
    const pending = {
      id: "GPA.pending",
      productId: "pro.android",
      platform: "android" as const,
      purchaseState: "pending",
      purchaseToken: "tok-pending",
      obfuscatedAccountIdAndroid: ada,
      isAcknowledgedAndroid: false,
      dataAndroid: '{"orderId":"GPA.pending","productId":"pro.android","purchaseToken":"tok-pending"}',
    };
    iap.available = [pending];
    await mountListener("android");
    await listening();
    await act(async () => {
      iap.complete(pending);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(submitted()).toEqual([]);
    expect(iap.finished).toEqual([]);
  });

  test("a renewal delivered twice is submitted once", async () => {
    await mountAsAda("ios");
    await listening();
    const renewal = delivered({ id: "t-renewal", purchaseToken: "jws-renewal" });
    await act(async () => {
      iap.complete(renewal);
      iap.complete(renewal);
    });
    await waitFor(() => expect(iap.finished).toHaveLength(1));
    expect(submitted()).toHaveLength(1);
  });

  test("on Android, a purchase Play still holds unacknowledged at launch is submitted verbatim and finished", async () => {
    await learnAda("android");
    const unacknowledged = {
      id: "GPA.1",
      productId: "pro.android",
      platform: "android" as const,
      purchaseState: "purchased",
      purchaseToken: "tok-1",
      obfuscatedAccountIdAndroid: ada,
      isAcknowledgedAndroid: false,
      dataAndroid: '{"orderId":"GPA.1","productId":"pro.android","purchaseToken":"tok-1"}',
    };
    const acknowledged = { ...unacknowledged, id: "GPA.2", isAcknowledgedAndroid: true };
    iap.available = [unacknowledged, acknowledged];
    await mountListener("android");
    await waitFor(() => expect(iap.finished).toEqual([{ purchase: unacknowledged, isConsumable: false }]));
    expect(submitted()).toEqual([{ rail: "google", receipt: unacknowledged.dataAndroid }]);
  });

  test("on iOS, the launch opens the store connection and submits what StoreKit still holds unfinished", async () => {
    await learnAda("ios");
    const unfinished = delivered({ id: "t-unfinished", purchaseToken: "jws-unfinished" });
    iap.available = [unfinished];
    await mountListener("ios");
    await waitFor(() => expect(iap.finished).toEqual([{ purchase: unfinished, isConsumable: false }]));
    expect(iap.connected).toBe(true);
    expect(submitted()).toEqual([{ rail: "apple", receipt: "jws-unfinished" }]);
  });

  test("on iOS, an Ask to Buy approval delivered while no screen is open goes through", async () => {
    await mountAsAda("ios");
    await waitFor(() => expect(iap.connected).toBe(true));
    const approved = delivered({ id: "t-approved-later", purchaseToken: "jws-approved-later" });
    await act(async () => {
      iap.complete(approved);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase: approved, isConsumable: false }]));
  });

  test("unmounting stops listening", async () => {
    const unmount = await mountAsAda("ios");
    await listening();
    unmount();
    expect(iap.updated.size).toBe(0);
  });

  test("the web, a web rail on a phone, and payments not composed listen to no store at all", async () => {
    iap.loads = 0;
    vi.resetModules();
    await mountListener("web");
    config.rails = { ios: "stripe", android: "google", web: "stripe" };
    cleanup();
    vi.resetModules();
    await mountListener("ios");
    config.rails = { ios: "apple", android: "google", web: "stripe" };
    config.payments = { enabled: false };
    cleanup();
    vi.resetModules();
    await mountListener("ios");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(iap.updated.size).toBe(0);
    expect(iap.connected).toBe(false);
    expect(iap.loads).toBe(0);
  });
});

describe("whose purchase it is", () => {
  test("a purchase tagged with another user's account token is neither submitted nor finished", async () => {
    await mountAsAda("ios");
    await listening();
    const bob = await tokenOf("user-bob");
    await act(async () => {
      iap.complete(delivered({ id: "t-bob", purchaseToken: "jws-bob", appAccountToken: bob }));
    });
    await settleAll();
    expect(submitted()).toEqual([]);
    expect(iap.finished).toEqual([]);
  });

  test("a purchase tagged on an earlier install, with a token this one never minted, goes through for the user", async () => {
    await mountAsAda("ios");
    await waitFor(() => expect(iap.connected).toBe(true));
    const earlier = delivered({
      id: "t-earlier",
      purchaseToken: "jws-earlier",
      appAccountToken: "6F1D2C3B-0000-4000-8000-00000000ADA0",
    });
    await act(async () => {
      iap.complete(earlier);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase: earlier, isConsumable: false }]));
    expect(submitted()).toEqual([{ rail: "apple", receipt: "jws-earlier" }]);
  });

  test("a purchase tagged with no account token is neither submitted nor finished", async () => {
    await mountAsAda("ios");
    await listening();
    await act(async () => {
      iap.complete(delivered({ id: "t-untagged", appAccountToken: null }));
      iap.complete(delivered({ id: "t-blank", appAccountToken: "" }));
    });
    await settleAll();
    expect(submitted()).toEqual([]);
    expect(iap.finished).toEqual([]);
  });

  test("on Android, Play's unacknowledged purchase for another user is left alone at launch", async () => {
    await learnAda("android");
    const bob = await tokenOf("user-bob");
    iap.available = [
      {
        id: "GPA.bob",
        productId: "pro.android",
        platform: "android" as const,
        purchaseState: "purchased",
        purchaseToken: "tok-bob",
        obfuscatedAccountIdAndroid: bob,
        isAcknowledgedAndroid: false,
        dataAndroid: '{"orderId":"GPA.bob","productId":"pro.android","purchaseToken":"tok-bob"}',
      },
    ];
    await mountListener("android");
    await listening();
    await settleAll();
    expect(submitted()).toEqual([]);
    expect(iap.finished).toEqual([]);
  });

  test("StoreKit's uppercase rendering of the token still matches", async () => {
    await mountAsAda("ios");
    await listening();
    const purchase = delivered({ appAccountToken: ada.toUpperCase() });
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase, isConsumable: false }]));
  });

  test("with nobody signed in, nothing is submitted, not even a purchase tagged for a user of this device", async () => {
    user = null;
    await mountAsAda("ios");
    await listening();
    await act(async () => {
      iap.complete(delivered());
    });
    await settleAll();
    expect(submitted()).toEqual([]);
    expect(iap.finished).toEqual([]);
  });

  test("signing in mid-launch submits that user's unfinished purchase, and finishes it once the Worker accepts", async () => {
    user = null;
    accepts = false;
    await mountAsAda("ios");
    await listening();
    const purchase = delivered({ id: "t-waiting", purchaseToken: "jws-waiting" });
    await act(async () => {
      iap.complete(purchase);
    });
    await settleAll();
    expect(submitted()).toEqual([]);

    iap.available = [purchase];
    user = "user-ada";
    const { transport } = await import("../templates/src/transport");
    await act(async () => {
      await transport.adopt("ada-token");
    });
    await waitFor(() => expect(submitted()).toEqual([{ rail: "apple", receipt: "jws-waiting" }]));
    await settleAll();
    expect(iap.finished).toEqual([]);

    accepts = true;
    await act(async () => {
      await transport.forget();
      await transport.adopt("ada-token-2");
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase, isConsumable: false }]));
    const purchases = calls.filter((call) => call.url.endsWith("/purchases"));
    expect((purchases.at(-1)?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer ada-token-2",
    );
  });

  test("on Android, signing in mid-launch submits the purchase Play holds for that user", async () => {
    user = "user-bob";
    await learnAda("android");
    const purchase = {
      id: "GPA.ada",
      productId: "pro.android",
      platform: "android" as const,
      purchaseState: "purchased",
      purchaseToken: "tok-ada",
      obfuscatedAccountIdAndroid: ada,
      isAcknowledgedAndroid: false,
      dataAndroid: '{"orderId":"GPA.ada","productId":"pro.android","purchaseToken":"tok-ada"}',
    };
    iap.available = [purchase];
    await mountListener("android");
    await listening();
    await settleAll();
    expect(submitted()).toEqual([]);

    user = "user-ada";
    const { transport } = await import("../templates/src/transport");
    await act(async () => {
      await transport.adopt("ada-token");
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase, isConsumable: false }]));
    expect(submitted()).toEqual([{ rail: "google", receipt: purchase.dataAndroid }]);
  });

  test("a purchase matched to one user is never sent under the credential of the next one to sign in", async () => {
    await mountAsAda("ios");
    await listening();
    const first = delivered({ id: "t-first", purchaseToken: "jws-first" });
    await act(async () => {
      iap.complete(first);
    });
    await waitFor(() => expect(iap.finished).toHaveLength(1));

    let release: () => void = () => undefined;
    secureStore.slowWrites = new Promise((resolve) => {
      release = resolve;
    });
    user = "user-bob";
    const { transport } = await import("../templates/src/transport");
    const adopting = transport.adopt("bob-token");
    await act(async () => {
      iap.complete(delivered({ id: "t-second", purchaseToken: "jws-second" }));
    });
    await settleAll();
    release();
    await act(async () => {
      await adopting;
    });
    await settleAll();
    const underBob = calls.filter(
      (call) =>
        call.url.endsWith("/purchases") &&
        (call.init.headers as Record<string, string> | undefined)?.authorization === "Bearer bob-token",
    );
    expect(underBob).toEqual([]);
    expect(iap.finished).toHaveLength(1);
  });

  test("a sign-in landing while the Worker is asked whose purchase it is cannot carry it off", async () => {
    await mountAsAda("ios");
    await listening();
    const { transport } = await import("../templates/src/transport");
    asked = () => {
      asked = null;
      secureStore.slowWrites = new Promise(() => undefined);
      void transport.adopt("bob-token");
    };
    const purchase = delivered({ id: "t-asked", purchaseToken: "jws-asked" });
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(iap.finished).toEqual([{ purchase, isConsumable: false }]));
    const sent = calls.filter((call) => call.url.endsWith("/purchases"));
    expect(sent.map((call) => (call.init.headers as Record<string, string> | undefined)?.authorization)).toEqual([
      "Bearer raw-token",
    ]);
  });

  test("signing out mid-launch stops submitting the last user's purchases", async () => {
    await mountAsAda("ios");
    await listening();
    user = null;
    const { transport } = await import("../templates/src/transport");
    await act(async () => {
      await transport.forget();
    });
    await act(async () => {
      iap.complete(delivered());
    });
    await settleAll();
    expect(submitted()).toEqual([]);
    expect(iap.finished).toEqual([]);
  });
});

describe("a purchase a screen is waiting on", () => {
  test("is submitted by the screen alone, never a second time by the launch listener", async () => {
    await mountAsAda("ios");
    await listening();
    const { useStoreSale } = await import("../templates/src/payments");
    let buy: () => Promise<void> = async () => undefined;
    function Screen(): ReactNode {
      const sale = useStoreSale();
      buy = () => sale.buy("apple", { sku: "pro.ios", type: "subscription" });
      return null;
    }
    await act(async () => {
      render(<Screen />);
    });
    await act(async () => {
      void buy();
    });
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    const purchase = delivered({ id: "t-screen", purchaseToken: "jws-screen" });
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(iap.finished).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(submitted()).toEqual([{ rail: "apple", receipt: "jws-screen" }]);
    expect(iap.finished).toHaveLength(1);
  });

  test("is not submitted again when the store hands it back once the screen has it", async () => {
    await mountAsAda("ios");
    await listening();
    const { useStoreSale } = await import("../templates/src/payments");
    let buy: () => Promise<void> = async () => undefined;
    function Screen(): ReactNode {
      const sale = useStoreSale();
      buy = () => sale.buy("apple", { sku: "pro.ios", type: "subscription" });
      return null;
    }
    await act(async () => {
      render(<Screen />);
    });
    await act(async () => {
      void buy();
    });
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    const purchase = delivered({ id: "t-screen", purchaseToken: "jws-screen" });
    await act(async () => {
      iap.complete(purchase);
    });
    await act(async () => {
      iap.complete(purchase);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(submitted()).toEqual([{ rail: "apple", receipt: "jws-screen" }]);
  });
});

describe("the root layout", () => {
  test("mounts the listener when the payments screens were written", async () => {
    vi.doMock("../templates/src/route-modules", async () => ({
      pithyRoutes: [],
      appRoutes: [],
      sessionModule: undefined,
      paymentsModule: undefined,
      storeTransactions: (await import("../templates/src/useStoreTransactions")).useStoreTransactions,
    }));
    Platform.OS = "ios";
    const { default: Layout } = await import("../templates/app/_layout");
    await act(async () => {
      render(<Layout />);
    });
    await listening();
    vi.doUnmock("../templates/src/route-modules");
  });
});
