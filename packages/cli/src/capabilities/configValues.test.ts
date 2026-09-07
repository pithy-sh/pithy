// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { coerceConfigValue } from "./flow";

/** `payments`' real option, in the shape its manifest states it. */
const BILLING_SUBJECT: ConfigOption = {
  key: "billingSubject",
  choices: ["user", "organization"],
  choicesNeedingCode: {
    organization:
      "It needs a `resolveSubject` seam. Add payments with --set billingSubject=user, then set both by hand.",
  },
  describe: "Who holds a subscription in this project.",
};

/**
 * **A choice `pithy add` can write and the kit will then refuse to load — #483.**
 *
 * `pithy add` renders JSON into `pithy.config.ts` and cannot render a function, so a choice whose
 * validity depends on a seam is one it must not write. `payments`' `organization` requires a
 * `resolveSubject` saying which organization a caller acts for; without it the capability refuses at
 * assembly, and since every `pithy` command begins by loading the config, the add that wrote it bricked
 * the project. Refusing costs one hand-edit. Writing it cost everything after.
 */
describe("a choice that needs code the CLI cannot write", () => {
  test("is refused, naming the seam and the way round", () => {
    const thrown = (() => {
      try {
        coerceConfigValue(BILLING_SUBJECT, "organization", "payments");
        return null;
      } catch (error) {
        return error as PithyError;
      }
    })();

    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown?.payload.action).toContain("resolveSubject");
    // The refusal names the value, not just the option: `billingSubject` itself is perfectly settable.
    expect(thrown?.payload.message).toContain("organization");
  });

  test("does not refuse the choice that composes on its own", () => {
    expect(coerceConfigValue(BILLING_SUBJECT, "user", "payments")).toBe("user");
  });

  // The pre-existing refusal is a different one, and both still fire. A value outside the set is a
  // mistake; a value inside it that needs code is a design constraint, and they read differently.
  test("still refuses a value the option does not offer, with the legal ones named", () => {
    const thrown = (() => {
      try {
        coerceConfigValue(BILLING_SUBJECT, "team", "payments");
        return null;
      } catch (error) {
        return error as PithyError;
      }
    })();

    expect(thrown?.payload.action).toContain("user, organization");
  });

  test("an option declaring none of them is unaffected", () => {
    const plain: ConfigOption = { key: "mode", choices: ["a", "b"], describe: "Pick one." };
    expect(coerceConfigValue(plain, "b", "cap")).toBe("b");
  });
});
