// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilityManifestConfig } from "@pithy-sh/core/src/controlPlane/discovery/configuration";
import { namedConfigValues } from "@pithy-sh/core/src/controlPlane/discovery/configuration";
import { describe, expect, test } from "vitest";
import { PaymentsSubjectType } from "../data/subject";
import { PAYMENTS_BILLING_SUBJECT, paymentsManifestConfig } from "./manifestConfig";

/**
 * What payments tells a management client about the one decision it cannot infer (#422).
 *
 * `billingSubject` is required with no default — PR #418 dropped the `user` default #412 proposed — so
 * there is no value a client may safely assume. It has to be told, and this is where it is told.
 */

describe("payments states what this project bills", () => {
  test("one key, valued at what the project actually configured", () => {
    const stated = paymentsManifestConfig("organization");
    expect(stated.keys.map((key) => key.key)).toEqual([PAYMENTS_BILLING_SUBJECT]);
    expect(stated.values).toEqual({ [PAYMENTS_BILLING_SUBJECT]: "organization" });
  });

  test("and a project billing people says so instead", () => {
    expect(paymentsManifestConfig("user").values).toEqual({ [PAYMENTS_BILLING_SUBJECT]: "user" });
  });

  test("the choices are the enum, so a third kind of holder cannot land unannounced", () => {
    // Asserted against `PaymentsSubjectType.options` rather than against `["user", "organization"]`. A
    // retyped literal passes only while the two agree, and the day they stop agreeing is the day a
    // client offers a picker missing the kind the adopter chose.
    expect(paymentsManifestConfig("user").keys[0]?.choices).toEqual([...PaymentsSubjectType.options]);
  });

  test("a client recovers the value through the declaration, never off a key it hardcoded", () => {
    const stated = paymentsManifestConfig("organization");
    expect(namedConfigValues({ configKeys: stated.keys, config: stated.values })).toEqual([
      { key: stated.keys[0], value: "organization" },
    ]);
  });

  test("an inline literal is not a declaration", () => {
    // The brand, and it is the compiler that holds it: the factory is the only door, so the value is
    // checked against its own choices before it can reach a manifest. Delete the brand and the directive
    // below stops being needed, which `bun run typecheck` reports as an unused `@ts-expect-error`.
    // @ts-expect-error — a hand-written object never went through `defineManifestConfig`.
    const sneaky: CapabilityManifestConfig = {
      keys: [{ key: PAYMENTS_BILLING_SUBJECT, choices: ["user", "organization"], summary: "What this project bills." }],
      values: { [PAYMENTS_BILLING_SUBJECT]: "organization" },
    };
    expect(sneaky.values).toEqual({ [PAYMENTS_BILLING_SUBJECT]: "organization" });
  });
});
