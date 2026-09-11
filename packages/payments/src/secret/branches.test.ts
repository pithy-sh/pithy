// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsRailToggles } from "../config/config";
import { PAYMENTS_RAILS } from "../data/rail";
import { paymentsInapplicableSecrets, paymentsSecretBranches } from "./branches";
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

/**
 * **The same question one level up: is the bundle reachable at all (#541).**
 *
 * Every rail is off until named, so this is the state `pithy add payments` leaves a project in — and
 * `pithy doctor` listed `payments-provider-credentials` as outstanding work for the whole of it, under
 * *"fine to leave until you need it"*. Every read of the bundle is behind a rail, so nothing reads it.
 */
describe("paymentsInapplicableSecrets", () => {
  test("no rail on puts the whole bundle out of reach, with the reason", () => {
    expect(paymentsInapplicableSecrets(OFF)).toEqual({
      [PAYMENTS_PROVIDER_SECRET]: "payments() enables no rail, so no code path reads a credential",
    });
  });

  test("one rail on is enough to leave it in reach", () => {
    // Which is the whole boundary: a rail that is on has routes, a webhook and a reconciliation pass
    // that each reach the store, so the credential is outstanding work again the moment one is named.
    expect(paymentsInapplicableSecrets(PaymentsRailToggles.parse({ paddle: true }))).toEqual({});
  });

  test("every rail on declares nothing", () => {
    const all = PaymentsRailToggles.parse(Object.fromEntries(PAYMENTS_RAILS.map((rail) => [rail, true])));
    expect(paymentsInapplicableSecrets(all)).toEqual({});
  });
});
