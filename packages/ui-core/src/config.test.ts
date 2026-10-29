// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { expect, expectTypeOf, test } from "vitest";
import {
  AUTH_DISABLED,
  CONSENT_DISABLED,
  I18N_DISABLED,
  PAYMENTS_DISABLED,
  type PaymentsProductConfig,
  TURNSTILE_DISABLED,
} from "./config";

test("every default is the not-composed branch, so a screen can bail on it", () => {
  for (const disabled of [AUTH_DISABLED, TURNSTILE_DISABLED, PAYMENTS_DISABLED, I18N_DISABLED, CONSENT_DISABLED]) {
    expect(disabled.enabled).toBe(false);
  }
});

test("nothing is on offer when a capability is absent", () => {
  expect(Object.values(AUTH_DISABLED.providers)).not.toContain(true);
  expect(Object.values(PAYMENTS_DISABLED.rails)).not.toContain(true);
  expect(PAYMENTS_DISABLED.products).toEqual([]);
  expect(PAYMENTS_DISABLED.paddle).toBeNull();
  expect(TURNSTILE_DISABLED.sitekey).toBe("");
});

test("consent's default base path is the one the capability mounts at when none is given", () => {
  expect(CONSENT_DISABLED.basePath).toBe("/consent");
});

test("the default locale is one the project is said to serve", () => {
  expect(I18N_DISABLED.supportedLocales).toContain(I18N_DISABLED.defaultLocale);
});

test("a product carries its store SKUs when the Worker projects them, and reads without them when it does not", () => {
  const web = { stripe: "price_1", lemonSqueezy: null, paddle: null };
  expectTypeOf({ ...web, apple: "com.acme.pro", google: null }).toMatchTypeOf<PaymentsProductConfig["skus"]>();
  expectTypeOf(web).toMatchTypeOf<PaymentsProductConfig["skus"]>();
  expectTypeOf<PaymentsProductConfig["skus"]["apple"]>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<PaymentsProductConfig["skus"]["google"]>().toEqualTypeOf<string | null | undefined>();
});
