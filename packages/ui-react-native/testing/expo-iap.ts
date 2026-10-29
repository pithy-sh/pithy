// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/** A product the store answers with, as far as the kit reads one. */
export interface StubProduct {
  id: string;
  title: string;
  displayPrice: string;
  platform: "ios" | "android";
  type: "in-app" | "subs";
  /** A Play subscription's offers; the purchase names one by its token. */
  subscriptionOffers?: { id: string; displayPrice: string; offerTokenAndroid?: string | null }[];
}

/** A purchase the store answers with, as far as the kit reads one. */
export interface StubPurchase {
  id: string;
  productId: string;
  platform: "ios" | "android";
  purchaseToken?: string | null;
  transactionId?: string | null;
  [field: string]: unknown;
}

type Listener<T> = (value: T) => void;

/**
 * `expo-iap`: StoreKit and Play Billing, as a test drives them. `iap.products` is the catalog the store answers
 * with; `iap.requests` logs every purchase asked for with what it was tagged with; `iap.complete` and `iap.fail`
 * play the store's answer to the purchase listeners, the way the native module does.
 */
export const iap = singleton("iap", () => ({
  connected: false,
  /** Whether the store refuses the connection, as it does with no StoreKit or Play Billing to reach. */
  unreachable: false,
  /** How many times the store was asked to restore. */
  restores: 0,
  /** How many times this module was evaluated: zero after `vi.resetModules()` means nothing imported it since. */
  loads: 0,
  /** Whether `finishTransaction` rejects, as it does when the store drops the connection after a purchase. */
  finishFailing: false,
  /** Whether `initConnection` throws rather than answering, as a native module that fails to start does. */
  connectThrows: false,
  /** How many times the connection was asked for. */
  connects: 0,
  /** The error `requestPurchase` rejects with, as StoreKit's does for a deferred or failed purchase, or null. */
  requestRejects: null as { code: string; message: string } | null,
  products: [] as StubProduct[],
  available: [] as StubPurchase[],
  requests: [] as unknown[],
  finished: [] as { purchase: StubPurchase; isConsumable?: boolean }[],
  updated: new Set<Listener<StubPurchase>>(),
  errors: new Set<Listener<{ code: string; message: string; productId?: string }>>(),
  /** Deliver `purchase`, the way the store does: only once the app has opened its connection. */
  complete(purchase: StubPurchase): void {
    if (!this.connected) return;
    for (const listener of this.updated) listener(purchase);
  },
  fail(error: { code: string; message: string; productId?: string }): void {
    if (!this.connected) return;
    for (const listener of this.errors) listener(error);
  },
  reset(): void {
    this.connected = false;
    this.unreachable = false;
    this.restores = 0;
    this.loads = 0;
    this.finishFailing = false;
    this.connectThrows = false;
    this.connects = 0;
    this.requestRejects = null;
    this.products = [];
    this.available = [];
    this.requests = [];
    this.finished = [];
    this.updated = new Set();
    this.errors = new Set();
  },
}));

iap.loads += 1;

export const ErrorCode = {
  UserCancelled: "user-cancelled",
  NetworkError: "network-error",
  ItemUnavailable: "item-unavailable",
  DeferredPayment: "deferred-payment",
} as const;

export async function initConnection(): Promise<boolean> {
  iap.connects += 1;
  if (iap.connectThrows) throw new Error("The store module failed to start.");
  iap.connected = !iap.unreachable;
  return iap.connected;
}

export async function endConnection(): Promise<boolean> {
  iap.connected = false;
  return true;
}

export async function fetchProducts(request: { skus: string[]; type?: string }): Promise<StubProduct[]> {
  return iap.products.filter((product) => request.skus.includes(product.id));
}

export async function requestPurchase(request: unknown): Promise<null> {
  iap.requests.push(request);
  if (iap.requestRejects !== null) throw iap.requestRejects;
  return null;
}

export async function finishTransaction(input: { purchase: StubPurchase; isConsumable?: boolean }): Promise<void> {
  if (iap.finishFailing) throw new Error("The store lost the connection.");
  iap.finished.push(input);
}

export async function restorePurchases(): Promise<void> {
  iap.restores += 1;
}

export async function getAvailablePurchases(): Promise<StubPurchase[]> {
  return iap.available;
}

/** StoreKit's unfinished transactions: the same set `getAvailablePurchases` answers with here. */
export async function getPendingTransactionsIOS(): Promise<StubPurchase[]> {
  return iap.available;
}

export function purchaseUpdatedListener(listener: Listener<StubPurchase>): { remove: () => void } {
  iap.updated.add(listener);
  return { remove: () => iap.updated.delete(listener) };
}

export function purchaseErrorListener(listener: Listener<{ code: string; message: string; productId?: string }>): {
  remove: () => void;
} {
  iap.errors.add(listener);
  return { remove: () => iap.errors.delete(listener) };
}

export async function deepLinkToSubscriptions(): Promise<void> {}
