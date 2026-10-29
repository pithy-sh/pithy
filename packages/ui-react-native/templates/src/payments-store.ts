import type * as ExpoIap from "expo-iap";

/**
 * The platform's store, StoreKit or Play Billing, through `expo-iap`.
 *
 * Metro resolves `./payments-store` to `payments-store.native.ts` on a phone and to this file on the web, so the
 * web bundle never carries `expo-iap`: the web sells on a hosted page and has no store to reach.
 */

/** `expo-iap`, as the store calls reach it. */
export type StoreModule = typeof ExpoIap;

/** The store on this platform. The web has none. */
export function loadStore(): Promise<StoreModule | null> {
  return Promise.resolve(null);
}
