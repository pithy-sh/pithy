// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsClientRail, PaymentsHostedRail } from "./api";
import type { PaymentsClientProduct } from "./projection";

/** The platform a screen renders on, as React Native's `Platform.OS` names the three it supports. */
export type PaymentsPlatform = "ios" | "android" | "web";

/** The rail a platform sells through, or `none` for a consumption-only build: plan shown, nothing sold. */
export type PaymentsRailChoice = PaymentsClientRail | "none";

/** One rail per platform, as a native app's `pithy-config` names them. */
export type PaymentsPlatformRails = Readonly<Record<PaymentsPlatform, PaymentsRailChoice>>;

/**
 * How a screen sells one product on this platform.
 *
 * `store` buys in the app through StoreKit or Play Billing, with the store's own product id. `hosted` asks
 * the Worker for a checkout on that rail and opens it — in the browser on native. `none` is the
 * consumption-only build: no price, no button, no link. `unavailable` is a product this platform cannot sell:
 * its rail is off on the backend, the product has no SKU there, or the rail is a store this platform does
 * not run.
 */
export type PaymentsPurchasePath =
  | { kind: "store"; rail: "apple" | "google"; sku: string }
  | { kind: "hosted"; rail: PaymentsHostedRail }
  | { kind: "none" }
  | { kind: "unavailable" };

/** The store each platform runs. The web runs neither. */
const PLATFORM_STORE: Readonly<Record<PaymentsPlatform, "apple" | "google" | null>> = {
  ios: "apple",
  android: "google",
  web: null,
};

/** The rails a platform defaults to: its own store on iOS and Android, and the project's web rail on the web. */
export function defaultPlatformRails(web: PaymentsRailChoice): PaymentsPlatformRails {
  return { ios: "apple", android: "google", web };
}

/** A SKU worth buying with: a non-empty string. Absent, null and empty all mean not sold there. */
function skuOf(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * How to sell `product` on `platform`, given the rail each platform is set to and the rails the backend has on.
 *
 * Pure, so a screen calls it while rendering and a test states every case. The backend's refusal is still the
 * boundary: this only decides what a screen offers.
 */
export function purchasePathFor(input: {
  platform: PaymentsPlatform;
  rails: PaymentsPlatformRails;
  enabled: Readonly<Record<PaymentsClientRail, boolean>>;
  product: Pick<PaymentsClientProduct, "skus">;
}): PaymentsPurchasePath {
  const { platform, rails, enabled, product } = input;
  const rail = rails[platform];
  if (rail === "none") return { kind: "none" };
  if (!enabled[rail]) return { kind: "unavailable" };

  if (rail === "apple" || rail === "google") {
    if (PLATFORM_STORE[platform] !== rail) return { kind: "unavailable" };
    const sku = skuOf(product.skus[rail]);
    return sku === null ? { kind: "unavailable" } : { kind: "store", rail, sku };
  }

  return skuOf(product.skus[rail]) === null ? { kind: "unavailable" } : { kind: "hosted", rail };
}
