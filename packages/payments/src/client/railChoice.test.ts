// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { PaymentsClientRail } from "./api";
import { defaultPlatformRails, type PaymentsPlatformRails, purchasePathFor } from "./railChoice";

/** Every rail on: the projection a project that sells everywhere carries. */
const ALL_ON: Record<PaymentsClientRail, boolean> = {
  apple: true,
  google: true,
  stripe: true,
  lemonSqueezy: true,
  paddle: true,
};

/** A product sold on every rail. */
const EVERYWHERE = {
  skus: {
    apple: "com.acme.pro.monthly",
    google: "acme.pro.monthly.v1",
    stripe: "price_1",
    lemonSqueezy: "123",
    paddle: "pri_01",
  },
};

/** The defaults, with web on Stripe. */
const RAILS: PaymentsPlatformRails = { ios: "apple", android: "google", web: "stripe" };

describe("purchasePathFor", () => {
  test("iOS on apple buys in the App Store with the product's Apple SKU", () => {
    expect(purchasePathFor({ platform: "ios", rails: RAILS, enabled: ALL_ON, product: EVERYWHERE })).toEqual({
      kind: "store",
      rail: "apple",
      sku: "com.acme.pro.monthly",
    });
  });

  test("Android on google buys in Play with the product's Play SKU", () => {
    expect(purchasePathFor({ platform: "android", rails: RAILS, enabled: ALL_ON, product: EVERYWHERE })).toEqual({
      kind: "store",
      rail: "google",
      sku: "acme.pro.monthly.v1",
    });
  });

  test("the web on a hosted rail checks out there", () => {
    expect(purchasePathFor({ platform: "web", rails: RAILS, enabled: ALL_ON, product: EVERYWHERE })).toEqual({
      kind: "hosted",
      rail: "stripe",
    });
  });

  test("a hosted rail on a native platform is still a hosted checkout — the app opens it in the browser", () => {
    for (const rail of ["stripe", "lemonSqueezy", "paddle"] as const) {
      expect(
        purchasePathFor({
          platform: "ios",
          rails: { ...RAILS, ios: rail },
          enabled: ALL_ON,
          product: EVERYWHERE,
        }),
      ).toEqual({ kind: "hosted", rail });
    }
  });

  test("none is consumption-only, whatever the product or the backend sells", () => {
    for (const platform of ["ios", "android", "web"] as const) {
      expect(
        purchasePathFor({
          platform,
          rails: { ios: "none", android: "none", web: "none" },
          enabled: ALL_ON,
          product: EVERYWHERE,
        }),
      ).toEqual({ kind: "none" });
    }
  });

  test("a rail the backend does not enable is unavailable, never a purchase that cannot complete", () => {
    expect(
      purchasePathFor({
        platform: "ios",
        rails: RAILS,
        enabled: { ...ALL_ON, apple: false },
        product: EVERYWHERE,
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      purchasePathFor({
        platform: "web",
        rails: RAILS,
        enabled: { ...ALL_ON, stripe: false },
        product: EVERYWHERE,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  test("a product with no SKU on the chosen rail is unavailable", () => {
    const webOnly = { skus: { stripe: "price_1", lemonSqueezy: null, paddle: null } };
    expect(purchasePathFor({ platform: "ios", rails: RAILS, enabled: ALL_ON, product: webOnly })).toEqual({
      kind: "unavailable",
    });
    const nullApple = { skus: { ...EVERYWHERE.skus, apple: null } };
    expect(purchasePathFor({ platform: "ios", rails: RAILS, enabled: ALL_ON, product: nullApple })).toEqual({
      kind: "unavailable",
    });
    const noStripe = { skus: { ...EVERYWHERE.skus, stripe: null } };
    expect(purchasePathFor({ platform: "web", rails: RAILS, enabled: ALL_ON, product: noStripe })).toEqual({
      kind: "unavailable",
    });
  });

  test("an empty SKU is no SKU", () => {
    const blank = { skus: { ...EVERYWHERE.skus, apple: "", stripe: "" } };
    expect(purchasePathFor({ platform: "ios", rails: RAILS, enabled: ALL_ON, product: blank })).toEqual({
      kind: "unavailable",
    });
    expect(purchasePathFor({ platform: "web", rails: RAILS, enabled: ALL_ON, product: blank })).toEqual({
      kind: "unavailable",
    });
  });

  test("a store rail on a platform that does not run that store is unavailable", () => {
    const crossed: PaymentsPlatformRails = { ios: "google", android: "apple", web: "apple" };
    for (const platform of ["ios", "android", "web"] as const) {
      expect(purchasePathFor({ platform, rails: crossed, enabled: ALL_ON, product: EVERYWHERE }), platform).toEqual({
        kind: "unavailable",
      });
    }
    expect(
      purchasePathFor({ platform: "web", rails: { ...RAILS, web: "google" }, enabled: ALL_ON, product: EVERYWHERE }),
    ).toEqual({ kind: "unavailable" });
  });

  test("only the platform's own choice is read", () => {
    // Android's rail is off and its product unsellable there; iOS is unaffected.
    expect(
      purchasePathFor({
        platform: "ios",
        rails: { ios: "apple", android: "paddle", web: "none" },
        enabled: { ...ALL_ON, paddle: false },
        product: EVERYWHERE,
      }),
    ).toEqual({ kind: "store", rail: "apple", sku: "com.acme.pro.monthly" });
  });
});

describe("defaultPlatformRails", () => {
  test("is apple on iOS, google on Android, and the given web rail on the web", () => {
    expect(defaultPlatformRails("paddle")).toEqual({ ios: "apple", android: "google", web: "paddle" });
    expect(defaultPlatformRails("none")).toEqual({ ios: "apple", android: "google", web: "none" });
  });
});
