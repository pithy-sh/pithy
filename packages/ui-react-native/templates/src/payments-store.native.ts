import type * as ExpoIap from "expo-iap";

/**
 * The platform's store, StoreKit or Play Billing, through `expo-iap`: the file Metro resolves `./payments-store` to
 * on a phone. The module loads on the first store call, so an app that never sells through a store never loads it.
 */

/** `expo-iap`, as the store calls reach it. */
export type StoreModule = typeof ExpoIap;

let loading: Promise<StoreModule | null> | null = null;

/** The store on this platform, loaded once. A failed load is forgotten, so the next call tries again. */
export function loadStore(): Promise<StoreModule | null> {
  loading ??= import("expo-iap").catch(() => {
    loading = null;
    return null;
  });
  return loading;
}
