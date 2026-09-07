// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { payments } from "../capability";
import type { PaymentsSubjectResolver } from "./subjectSeam";
import { isUnimplementedSubject, requireImplementedSubject, unimplementedSubject } from "./unimplementedSubject";

/**
 * **The two halves of #500, and the reason they are two.**
 *
 * `pithy add payments --set billingSubject=organization` scaffolds a resolver rather than refusing the
 * value. Everything below is the guarantee that buys: the config **loads**, so the adopter still has a
 * working `pithy` in the project the scaffold landed in, and the Worker **does not boot**, so nothing ever
 * serves a request against a resolver that answers nobody.
 *
 * Both are needed. A refusal at composition would brick every CLI command — every one of them evaluates
 * the Worker's `pithy.config.ts` to learn what it composes, which is the #483 regression turned inside
 * out. No refusal at all would be the stub this design exists to avoid: composed cleanly, denying every
 * gate, indistinguishable from a customer who has not paid.
 */

const CATALOG = {
  rails: { stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: {
      type: "subscription" as const,
      name: "Pro",
      entitlements: ["pro"],
      stripe: { priceId: "price_1Abc" },
    },
  },
};

const implemented: PaymentsSubjectResolver = async () => ({ subjectType: "organization", subjectId: "acme" });

describe("the scaffolded placeholder", () => {
  test("is recognizable as unimplemented, and nothing else is", () => {
    expect(isUnimplementedSubject(unimplementedSubject)).toBe(true);
    expect(isUnimplementedSubject(implemented)).toBe(false);
    // An absent resolver is a different fault with a different remedy — `requireResolvableSubject` owns it.
    expect(isUnimplementedSubject(undefined)).toBe(false);
  });

  test("throws rather than answering, if anything ever calls it", async () => {
    // Belt and braces: a deployed Worker never reaches this, because `boot` refused. What it covers is
    // every other way the function can be reached, where a quiet `undefined` would be the silent-denial
    // failure the whole design rejects.
    await expect(unimplementedSubject({} as never)).rejects.toThrow(PithyError);
  });
});

describe("composition", () => {
  test("accepts the placeholder — the config must still load", () => {
    // The seam the CLI depends on. `payments()` runs whenever a Worker's pithy.config.ts is evaluated, and
    // `loadWorkerConfig` evaluates it on nearly every `pithy` command. A throw here is a project with no
    // toolchain left to fix itself with.
    expect(() =>
      payments({ ...CATALOG, billingSubject: "organization", resolveSubject: unimplementedSubject }),
    ).not.toThrow();
  });

  test("still refuses an absent resolver, unchanged", () => {
    expect(() => payments({ ...CATALOG, billingSubject: "organization" })).toThrow(PithyError);
  });
});

describe("boot", () => {
  test("refuses the placeholder, naming the file and the alternative", () => {
    const capability = payments({ ...CATALOG, billingSubject: "organization", resolveSubject: unimplementedSubject });

    const thrown = (() => {
      try {
        capability.boot?.({ capabilities: [capability] });
        return null;
      } catch (error) {
        return error as PithyError;
      }
    })();

    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown?.payload.action).toContain("src/billing/subject.ts");
    expect(thrown?.payload.action).toContain('billingSubject: "user"');
  });

  test("passes once the adopter has written one", () => {
    const capability = payments({ ...CATALOG, billingSubject: "organization", resolveSubject: implemented });
    expect(() => capability.boot?.({ capabilities: [capability] })).not.toThrow();
  });

  test("passes under user billing, which never had a seam to scaffold", () => {
    const capability = payments({ ...CATALOG, billingSubject: "user" });
    expect(() => capability.boot?.({ capabilities: [capability] })).not.toThrow();
  });
});

describe("requireImplementedSubject", () => {
  test("is silent for anything but the placeholder", () => {
    expect(() => requireImplementedSubject(implemented)).not.toThrow();
    expect(() => requireImplementedSubject(undefined)).not.toThrow();
    expect(() => requireImplementedSubject(unimplementedSubject)).toThrow(PithyError);
  });
});
