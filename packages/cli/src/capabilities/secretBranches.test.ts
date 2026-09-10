// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { mergeSecretBranches, secretBranchDeclarations } from "./secretBranches";

/** A capability with nothing on it but a name and, sometimes, a branch declaration. */
function capability(name: string, secretBranches?: Record<string, readonly string[]>): Capability {
  return { name, requiredBindings: [], ...(secretBranches ? { secretBranches } : {}) } as Capability;
}

describe("secretBranchDeclarations", () => {
  test("reads what a capability declared, in the order it declared it", () => {
    expect(
      secretBranchDeclarations([capability("payments", { "payments-provider-credentials": ["stripe", "paddle"] })]),
    ).toEqual({ "payments-provider-credentials": ["stripe", "paddle"] });
  });

  test("a capability that declares nothing contributes nothing — absent, not empty", () => {
    expect(secretBranchDeclarations([capability("auth"), capability("secrets")])).toEqual({});
  });

  test("two capabilities' declarations merge by secret name, without repeating a branch", () => {
    expect(
      secretBranchDeclarations([
        capability("payments", { "payments-provider-credentials": ["stripe"] }),
        capability("turnstile", { "turnstile-secret-keys": ["visible"] }),
        capability("app", { "payments-provider-credentials": ["stripe", "paddle"] }),
      ]),
    ).toEqual({
      "payments-provider-credentials": ["stripe", "paddle"],
      "turnstile-secret-keys": ["visible"],
    });
  });
});

describe("mergeSecretBranches", () => {
  test("takes the union across Workers, because the project stores one value", () => {
    // One Worker sells through Stripe and another through Paddle. There is one
    // `payments-provider-credentials` row per environment, and it has to carry both blocks — an
    // intersection would refuse to write the credentials a live Worker reads.
    expect(
      mergeSecretBranches(
        { "payments-provider-credentials": ["stripe"] },
        { "payments-provider-credentials": ["paddle"], "turnstile-secret-keys": ["invisible"] },
      ),
    ).toEqual({
      "payments-provider-credentials": ["stripe", "paddle"],
      "turnstile-secret-keys": ["invisible"],
    });
  });

  test("a name declared as empty by every Worker stays empty rather than becoming absent", () => {
    expect(mergeSecretBranches({}, { "payments-provider-credentials": [] })).toEqual({
      "payments-provider-credentials": [],
    });
  });
});
