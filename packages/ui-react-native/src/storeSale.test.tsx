// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { AUTH_DISABLED } from "@pithy-sh/ui-core/src/config";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Platform, Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { iap } from "../testing/expo-iap";
import { secureStore } from "../testing/expo-secure-store";

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  authConfig: { ...AUTH_DISABLED, enabled: true },
  paymentsConfig: {
    enabled: true,
    environment: "dev",
    rails: { apple: true, google: true, stripe: true, lemonSqueezy: false, paddle: false },
    basePath: "/payments",
    paddle: null,
    products: [
      {
        id: "pro",
        type: "non_consumable",
        entitlements: ["pro"],
        name: "Pro",
        skus: { apple: "pro.ios", google: "pro.android", stripe: null, lemonSqueezy: null, paddle: null },
      },
    ],
  },
  platformRails: { ios: "apple", android: "google", web: "stripe" },
}));

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

let calls: string[] = [];
/** The credential each `/purchases` and `/restore` request carried, in order. */
let sentUnder: string[] = [];
let user: { id: string } | null = null;
/** Run once the Worker is asked who is signed in, before it answers. */
let asked: (() => void) | null = null;

/** The credential a request carried, or an empty string for none. */
function credentialOf(init?: RequestInit): string {
  return (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
}

beforeEach(() => {
  calls = [];
  sentUnder = [];
  user = { id: "user-ada" };
  asked = null;
  secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "ada-token", expiresAt: null }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/get-session")) asked?.();
    if (url.endsWith("/purchases")) sentUnder.push(credentialOf(init));
    let body: unknown = {};
    if (url.endsWith("/get-session")) body = user === null ? null : { user: { ...user, email: "ada@example.com" } };
    else if (url.endsWith("/purchases"))
      body = { purchase: PURCHASE_VIEW, entitlements: [{ key: "pro", granted: true, expiresAt: null }] };
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

const ITEM = { sku: "pro.ios", type: "non_consumable" } as const;

/** `useStoreSale` alone: one button that buys Pro, and what the last call came to. */
async function mountSale(platform: "ios" | "web", answerWithin?: number): Promise<void> {
  Platform.OS = platform;
  const { useStoreSale } = await import("../templates/src/payments");
  function Sale(): ReactNode {
    const sale = useStoreSale(answerWithin === undefined ? {} : { answerWithin });
    return (
      <>
        <Pressable role="button" onPress={() => void sale.buy("apple", ITEM)}>
          <Text>Buy</Text>
        </Pressable>
        <Text testID="outcome">{`${sale.busy ? "busy" : (sale.outcome ?? "none")}:${sale.failure?.code ?? ""}`}</Text>
      </>
    );
  }
  await act(async () => {
    render(<Sale />);
  });
}

const outcome = (): string => screen.getByTestId("outcome").textContent ?? "";

async function buy(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Buy" }));
  });
}

const bought = {
  id: "t1",
  productId: "pro.ios",
  platform: "ios" as const,
  purchaseState: "purchased",
  purchaseToken: "jws",
};

/** The token Ada's purchases on this device carry, as the app mints it. */
async function adaToken(): Promise<string> {
  const { accountToken } = await import("../templates/src/payments");
  const token = await accountToken("user-ada");
  if (token === null) throw new Error("This device kept no account token.");
  return token;
}

/** What StoreKit answers Ada's purchase with. */
async function adaBought(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown> & typeof bought> {
  return { ...bought, appAccountToken: (await adaToken()).toUpperCase(), ...overrides };
}

describe("a store purchase", () => {
  test("nobody signed in is refused by name, and the store is never asked", async () => {
    user = null;
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(outcome()).toBe("refused:payments/store.signed_out"));
    expect(iap.requests).toEqual([]);
  });

  test("a device that cannot keep an account token is refused by name, and the store is never asked", async () => {
    await mountSale("ios");
    const { transport } = await import("../templates/src/transport");
    await transport.session();
    secureStore.failing = true;
    await buy();
    await waitFor(() => expect(outcome()).toBe("refused:payments/store.no_token"));
    expect(iap.requests).toEqual([]);
  });

  test("a store that never answers ends in a refusal of its own once the deadline passes", async () => {
    await mountSale("ios", 30);
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    await waitFor(() => expect(outcome()).toBe("refused:payments/store.no_answer"));
    expect(iap.updated.size).toBe(0);
    expect(iap.errors.size).toBe(0);
  });

  test("a store that cannot finish a purchase the Worker accepted still reports it bought", async () => {
    iap.finishFailing = true;
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    const purchase = await adaBought();
    await act(async () => {
      iap.complete(purchase);
    });
    await waitFor(() => expect(outcome()).toBe("bought:"));
    expect(calls.filter((url) => url.endsWith("/purchases"))).toHaveLength(1);
  });

  test("a replayed purchase tagged for another user is never taken as the buyer's answer", async () => {
    Platform.OS = "ios";
    const { accountToken } = await import("../templates/src/payments");
    const bob = await accountToken("user-bob");
    await mountSale("ios", 60);
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    await act(async () => {
      iap.complete({ ...bought, id: "t-bob", purchaseToken: "jws-bob", appAccountToken: bob?.toUpperCase() });
      iap.complete({ ...bought, id: "t-untagged", purchaseToken: "jws-untagged" });
    });
    await waitFor(() => expect(outcome()).toBe("refused:payments/store.no_answer"));
    expect(calls.filter((url) => url.endsWith("/purchases"))).toEqual([]);
    expect(iap.finished).toEqual([]);
  });

  test("the buyer's own purchase still lands after another user's replayed one", async () => {
    Platform.OS = "ios";
    const { accountToken } = await import("../templates/src/payments");
    const bob = await accountToken("user-bob");
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    const own = await adaBought({ id: "t-ada", purchaseToken: "jws-ada" });
    await act(async () => {
      iap.complete({ ...bought, id: "t-bob", purchaseToken: "jws-bob", appAccountToken: bob });
      iap.complete(own);
    });
    await waitFor(() => expect(outcome()).toBe("bought:"));
    expect(iap.finished.map((entry) => entry.purchase.id)).toEqual(["t-ada"]);
  });

  test("another user's replayed pending purchase never tells this buyer theirs is still processing", async () => {
    Platform.OS = "ios";
    const { accountToken } = await import("../templates/src/payments");
    const bob = await accountToken("user-bob");
    await mountSale("ios", 60);
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    await act(async () => {
      iap.complete({ ...bought, id: "t-bob", purchaseState: "pending", purchaseToken: null, appAccountToken: bob });
      iap.complete({ ...bought, id: "t-untagged", purchaseState: "pending", purchaseToken: null });
    });
    await waitFor(() => expect(outcome()).toBe("refused:payments/store.no_answer"));
  });

  test("the buyer's own pending purchase is pending", async () => {
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    const own = await adaBought({ purchaseState: "pending", purchaseToken: null });
    await act(async () => {
      iap.complete(own);
    });
    await waitFor(() => expect(outcome()).toBe("pending:"));
  });

  test("an Ask to Buy request StoreKit reports as a deferred payment is pending, not refused", async () => {
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    await act(async () => {
      iap.fail({ code: "deferred-payment", message: "Waiting for approval.", productId: "pro.ios" });
    });
    await waitFor(() => expect(outcome()).toBe("pending:"));
  });

  test("a deferred payment StoreKit rejects the request with is pending, not refused", async () => {
    iap.requestRejects = { code: "deferred-payment", message: "Waiting for approval." };
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(outcome()).toBe("pending:"));
  });

  test("a purchase is sent under the credential its buyer was read from, even when another sign-in lands first", async () => {
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    const { transport } = await import("../templates/src/transport");
    user = { id: "user-bob" };
    await act(async () => {
      await transport.adopt("bob-token");
    });
    await act(async () => {
      iap.complete(await adaBought());
    });
    await waitFor(() => expect(outcome()).toBe("bought:"));
    expect(sentUnder).toEqual(["Bearer ada-token"]);
  });

  test("a store that cannot finish restored purchases the Worker accepted still reports them restored", async () => {
    iap.finishFailing = true;
    iap.available = [bought];
    await mountRestore();
    await restore();
    await waitFor(() => expect(outcome()).toBe("restored:"));
    expect(screen.getByTestId("granted").textContent).toBe("pro");
  });

  test("restore never submits a purchase tagged for another user on this device", async () => {
    Platform.OS = "ios";
    const { accountToken } = await import("../templates/src/payments");
    const ada = await accountToken("user-ada");
    const bob = await accountToken("user-bob");
    iap.available = [
      { ...bought, id: "t-ada", purchaseToken: "jws-ada", appAccountToken: ada?.toUpperCase() },
      { ...bought, id: "t-bob", purchaseToken: "jws-bob", appAccountToken: bob },
      { ...bought, id: "t-none", purchaseToken: "jws-none" },
    ];
    await mountRestore();
    await restore();
    await waitFor(() => expect(outcome()).toBe("restored:"));
    expect(restored).toEqual([["jws-ada", "jws-none"]]);
    expect(iap.finished.map((entry) => entry.purchase.id).sort()).toEqual(["t-ada", "t-none"]);
  });

  test("restore never submits another user's purchase when the tokens this device minted cannot be read", async () => {
    Platform.OS = "ios";
    const { accountToken } = await import("../templates/src/payments");
    const ada = await accountToken("user-ada");
    const bob = await accountToken("user-bob");
    secureStore.items.set("pithy.payments.accounts", "{not a list");
    iap.available = [
      { ...bought, id: "t-ada", purchaseToken: "jws-ada", appAccountToken: ada },
      { ...bought, id: "t-bob", purchaseToken: "jws-bob", appAccountToken: bob },
    ];
    await mountRestore();
    await restore();
    await waitFor(() => expect(outcome()).toBe("restored:"));
    expect(restored).toEqual([["jws-ada"]]);
  });

  test("a user's token missing from this device's list is listed again, so their purchase stays theirs", async () => {
    Platform.OS = "ios";
    const { accountToken } = await import("../templates/src/payments");
    const ada = await accountToken("user-ada");
    const bob = await accountToken("user-bob");
    secureStore.items.set("pithy.payments.accounts", JSON.stringify([ada]));
    expect(await accountToken("user-bob")).toBe(bob);
    iap.available = [
      { ...bought, id: "t-ada", purchaseToken: "jws-ada", appAccountToken: ada },
      { ...bought, id: "t-bob", purchaseToken: "jws-bob", appAccountToken: bob },
    ];
    await mountRestore();
    await restore();
    await waitFor(() => expect(outcome()).toBe("restored:"));
    expect(restored).toEqual([["jws-ada"]]);
  });

  test("restore submits the user's purchase tagged on an earlier install, whose token this one never minted", async () => {
    iap.available = [
      {
        ...bought,
        id: "t-before",
        purchaseToken: "jws-before",
        appAccountToken: "6F1D2C3B-0000-4000-8000-00000000ADA0",
      },
    ];
    await mountRestore();
    await restore();
    await waitFor(() => expect(outcome()).toBe("restored:"));
    expect(restored).toEqual([["jws-before"]]);
    expect(iap.finished.map((entry) => entry.purchase.id)).toEqual(["t-before"]);
  });

  test("restore sends the receipts under the credential the user was read from", async () => {
    Platform.OS = "ios";
    iap.available = [await adaBought()];
    await mountRestore();
    const { transport } = await import("../templates/src/transport");
    asked = () => {
      asked = null;
      secureStore.slowWrites = new Promise(() => undefined);
      void transport.adopt("bob-token");
    };
    await restore();
    await waitFor(() => expect(outcome()).toBe("restored:"));
    expect(sentUnder).toEqual(["Bearer ada-token"]);
  });

  test("restore with nobody signed in is refused by name, and nothing is submitted", async () => {
    user = null;
    iap.available = [bought];
    await mountRestore();
    await restore();
    await waitFor(() => expect(outcome()).toBe("refused:payments/store.signed_out"));
    expect(restored).toEqual([]);
  });

  test("restore with only other users' purchases has nothing to restore", async () => {
    Platform.OS = "ios";
    const { accountToken } = await import("../templates/src/payments");
    const bob = await accountToken("user-bob");
    iap.available = [{ ...bought, id: "t-bob", purchaseToken: "jws-bob", appAccountToken: bob }];
    await mountRestore();
    await restore();
    await waitFor(() => expect(outcome()).toBe("nothing_to_restore:"));
    expect(restored).toEqual([]);
  });
});

let restored: string[][] = [];

/** `useStoreSale` alone: one button that restores, what it came to, and what the Worker granted. */
async function mountRestore(): Promise<void> {
  restored = [];
  Platform.OS = "ios";
  const { useStoreSale } = await import("../templates/src/payments");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/get-session")) asked?.();
    if (url.endsWith("/restore")) sentUnder.push(credentialOf(init));
    let body: unknown = {};
    if (url.endsWith("/get-session")) body = user === null ? null : { user: { ...user, email: "ada@example.com" } };
    else if (url.endsWith("/restore")) {
      restored.push((JSON.parse(String(init?.body ?? "{}")) as { receipts: string[] }).receipts);
      body = { purchases: [PURCHASE_VIEW], entitlements: [{ key: "pro", granted: true, expiresAt: null }] };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  function Restore(): ReactNode {
    const sale = useStoreSale();
    return (
      <>
        <Pressable role="button" onPress={() => void sale.restore("apple")}>
          <Text>Restore</Text>
        </Pressable>
        <Text testID="outcome">{`${sale.busy ? "busy" : (sale.outcome ?? "none")}:${sale.failure?.code ?? ""}`}</Text>
        <Text testID="granted">{sale.entitlements.map((held) => held.key).join(",")}</Text>
      </>
    );
  }
  await act(async () => {
    render(<Restore />);
  });
}

async function restore(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  });
}

describe("the web bundle", () => {
  test("never imports expo-iap at run time, even when a store call is made", async () => {
    vi.resetModules();
    iap.loads = 0;
    await mountSale("web");
    const payments = await import("../templates/src/payments");
    await expect(payments.readStoreListings([ITEM])).rejects.toThrow();
    await buy();
    await waitFor(() => expect(outcome()).toBe("refused:payments/store.no_token"));
    expect(iap.loads).toBe(0);

    cleanup();
    vi.resetModules();
    await mountSale("ios");
    await buy();
    await waitFor(() => expect(iap.requests).toHaveLength(1));
    expect(iap.loads).toBe(1);
  });
});

describe("the store connection", () => {
  const listed = {
    id: "pro.ios",
    title: "Pro",
    displayPrice: "$4.99",
    platform: "ios" as const,
    type: "in-app" as const,
  };

  test("a refused connection is tried again on the next store call", async () => {
    Platform.OS = "ios";
    iap.products = [listed];
    iap.unreachable = true;
    const { readStoreListings } = await import("../templates/src/payments");
    await expect(readStoreListings([ITEM])).rejects.toThrow("The store didn't answer.");
    iap.unreachable = false;
    const listings = await readStoreListings([ITEM]);
    expect(listings.get("pro.ios")?.displayPrice).toBe("$4.99");
    expect(iap.connects).toBe(2);
  });

  test("a connection that throws is refused like one the store declined, and tried again", async () => {
    Platform.OS = "ios";
    iap.products = [listed];
    iap.connectThrows = true;
    const { readStoreListings } = await import("../templates/src/payments");
    await expect(readStoreListings([ITEM])).rejects.toThrow("The store didn't answer.");
    iap.connectThrows = false;
    const listings = await readStoreListings([ITEM]);
    expect(listings.get("pro.ios")?.displayPrice).toBe("$4.99");
    expect(iap.connects).toBe(2);
  });

  test("an open connection is opened once", async () => {
    Platform.OS = "ios";
    iap.products = [listed];
    const { readStoreListings } = await import("../templates/src/payments");
    await readStoreListings([ITEM]);
    await readStoreListings([ITEM]);
    expect(iap.connects).toBe(1);
  });
});
