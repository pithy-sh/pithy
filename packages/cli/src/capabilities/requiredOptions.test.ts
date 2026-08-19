// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { isRequired, requiredOptionRefusal, unsettledOptions } from "./requiredOptions";

const BILLING = { key: "billingSubject", choices: ["user", "organization"] } as const;
const BASE_PATH = { key: "basePath", default: "/payments" } as const;
const OPEN = { key: "region" } as const;

describe("isRequired", () => {
  test("an option with no default is required; one with a default is not", () => {
    expect(isRequired(BILLING)).toBe(true);
    expect(isRequired(BASE_PATH)).toBe(false);
    // A falsy default is still a default. `false` and `0` and `""` are answers.
    expect(isRequired({ key: "cookies", default: false })).toBe(false);
    expect(isRequired({ key: "days", default: 0 })).toBe(false);
    expect(isRequired({ key: "prefix", default: "" })).toBe(false);
  });
});

describe("unsettledOptions", () => {
  test("names only the required options nobody answered, in manifest order", () => {
    expect(unsettledOptions([BASE_PATH, BILLING, OPEN], {}).map((option) => option.key)).toEqual([
      "billingSubject",
      "region",
    ]);
  });

  test("an answered required option is settled, whichever path answered it", () => {
    expect(unsettledOptions([BASE_PATH, BILLING], { billingSubject: "user" })).toEqual([]);
  });
});

describe("requiredOptionRefusal", () => {
  test("the action names the flag and every value it takes", () => {
    const error: PithyError = requiredOptionRefusal({ capability: "payments", missing: [BILLING] });
    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toBe("payments needs a value for billingSubject, and nothing in this run names one.");
    expect(error.payload.action).toBe("Pass --set billingSubject=user or --set billingSubject=organization.");
  });

  test("an option with no closed set is named with a placeholder rather than a guess", () => {
    const error = requiredOptionRefusal({ capability: "payments", missing: [OPEN] });
    expect(error.payload.action).toBe("Pass --set region=<value>.");
  });

  test("several unanswered options are all named — one refusal, not one per re-run", () => {
    const error = requiredOptionRefusal({ capability: "payments", missing: [BILLING, OPEN] });
    expect(error.message).toContain("billingSubject and region");
    expect(error.payload.action).toContain("--set billingSubject=user");
    expect(error.payload.action).toContain("--set region=<value>");
  });

  test("the detail is the throw site's — it says why there is nothing to render", () => {
    const error = requiredOptionRefusal({ capability: "payments", missing: [BILLING] });
    expect(error.payload.detail).toContain("no default");
  });
});
