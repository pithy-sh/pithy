// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsRailToggles } from "../config/config";
import { PAYMENTS_RAILS } from "../data/rail";
import { paymentsSecretBranches } from "./branches";
import { PAYMENTS_PROVIDER_SECRET, PaymentsProviderCredentials } from "./registry";

const OFF = PaymentsRailToggles.parse({});

describe("paymentsSecretBranches", () => {
  test("names the rails that are on, and only those", () => {
    expect(paymentsSecretBranches(PaymentsRailToggles.parse({ stripe: true, paddle: true }))).toEqual({
      [PAYMENTS_PROVIDER_SECRET]: ["stripe", "paddle"],
    });
  });

  test("one rail on is one branch — the prompt then has nothing to ask about", () => {
    expect(paymentsSecretBranches(PaymentsRailToggles.parse({ paddle: true }))[PAYMENTS_PROVIDER_SECRET]).toEqual([
      "paddle",
    ]);
  });

  test("no rail on declares none — which is the fallback, not five rails offered to nobody", () => {
    expect(paymentsSecretBranches(OFF)).toEqual({ [PAYMENTS_PROVIDER_SECRET]: [] });
  });

  test("every rail it can name is a key the credentials schema has", () => {
    // The seam and the schema are two halves of one capability, and the CLI refuses a declaration that
    // names a key the schema does not carry. This is what keeps that refusal about a *change* rather
    // than about the state of the package.
    const declared = paymentsSecretBranches(
      PaymentsRailToggles.parse(Object.fromEntries(PAYMENTS_RAILS.map((rail) => [rail, true]))),
    );
    expect(declared[PAYMENTS_PROVIDER_SECRET]).toEqual([...PAYMENTS_RAILS]);
    expect(Object.keys(PaymentsProviderCredentials.shape).sort()).toEqual([...PAYMENTS_RAILS].sort());
  });
});
