// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  PaymentsPaddleSettings,
  type PaymentsPaddleSettingsInput,
  PaymentsProduct,
  type PaymentsProductInput,
  PaymentsRailToggles,
  type PaymentsRailTogglesInput,
} from "./index";

/**
 * The barrel publishes the config module whole, and a catalog assembled in TypeScript can be typed from
 * it (#357).
 *
 * `src/config/config.ts` is the one module an adopter writes *against* rather than calls: `pithy.config.ts`
 * names its schemas, and a catalog built from a map of price ids — which is what makes those ids swappable
 * per environment — needs a name for every piece it builds. So the rule for this module is not the narrow
 * one the rest of the barrel follows. **Everything `config.ts` exports, the barrel publishes.** Anything
 * genuinely internal to it stays unexported there, which is where `MAX_NAME_LENGTH` and friends already are.
 *
 * That is stated as an invariant rather than as a list of names on purpose. The defect this replaces was
 * three input types where only some were reachable from the barrel — `PaymentsStripeSettingsInput` was,
 * `PaymentsPaddleSettingsInput` was not — and a list would have had to be remembered rather than derived.
 * A new export in `config.ts` enrols itself here; a barrel edit that drops one goes red.
 */
describe("the barrel publishes the config module whole (#357)", () => {
  const src = join(import.meta.dirname, "config", "config.ts");
  const barrel = join(import.meta.dirname, "index.ts");

  /** Every name `config.ts` exports. A const and its inferred type share a name, so the set dedupes them. */
  function configExports(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const match of readFileSync(src, "utf8").matchAll(/^export (?:const|type|interface|function) (\w+)/gm)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
    return names;
  }

  /** Every name the barrel re-exports from `./config/config`, with `type` specifiers and aliases resolved. */
  function barrelExports(): ReadonlySet<string> {
    const clause = /export \{([^}]*)\} from "\.\/config\/config";/.exec(readFileSync(barrel, "utf8"));
    // A barrel that re-exports the module some other way is the failure this block exists to catch, so it
    // is asserted rather than thrown: the report then names the invariant instead of naming a regex.
    expect(clause?.[1], "the barrel re-exports ./config/config").toBeTypeOf("string");
    const names = new Set<string>();
    for (const specifier of (clause?.[1] ?? "").split(",")) {
      const name = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1);
      if (name !== undefined && name.length > 0) names.add(name);
    }
    return names;
  }

  test("nothing the config module exports is missing from the barrel", () => {
    const published = barrelExports();
    expect([...configExports()].filter((name) => !published.has(name)).sort()).toEqual([]);
  });

  test("the input types a catalog is assembled from are among them", () => {
    // Named as well as derived. These three are what the dashboard hit — the invariant above covers them,
    // and this says which names the invariant was written for, so a reader is not left to infer it.
    const published = barrelExports();
    expect(published.has("PaymentsProductInput")).toBe(true);
    expect(published.has("PaymentsRailTogglesInput")).toBe(true);
    expect(published.has("PaymentsPaddleSettingsInput")).toBe(true);
  });
});

/**
 * The input types are the *written* shape, not the parsed one — which is the whole reason they exist.
 * Typing an unparsed product with `PaymentsProduct` demands `entitlements` and `clawback` back from an
 * author the schema is about to default for. These tests do not compile if that stops being true.
 */
describe("a catalog can be written against the input types (#357)", () => {
  test("a product omits the fields the schema defaults", () => {
    const product: PaymentsProductInput = {
      type: "subscription",
      name: "Solo, monthly",
      paddle: { priceId: "pri_01kzvyz9e21z9vbhd7xqq3csyh" },
    };
    const parsed = PaymentsProduct.parse(product);
    expect(parsed.entitlements).toEqual([]);
    expect(parsed.clawback).toBe(false);
  });

  test("rail toggles name only the rails that are on", () => {
    const rails: PaymentsRailTogglesInput = { paddle: true };
    expect(PaymentsRailToggles.parse(rails)).toEqual({
      apple: false,
      google: false,
      stripe: false,
      lemonSqueezy: false,
      paddle: true,
    });
  });

  test("paddle settings omit the checkout mode the schema defaults", () => {
    const settings: PaymentsPaddleSettingsInput = {
      clientToken: "test_682bec647f93d37fd95a1b700db",
      environment: "sandbox",
      successUrl: "https://example.com/billing",
    };
    expect(PaymentsPaddleSettings.parse(settings).checkout).toBe("overlay");
  });
});
