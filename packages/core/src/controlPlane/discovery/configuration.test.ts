// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { defineCapability } from "../../capability/capability";
import { PithyError } from "../../error/pithyError";
import { defineManifestConfig, ManifestConfigKey, namedConfigValues } from "./configuration";

/**
 * The configured-fact seam: a capability states a decision an adopter already made, so a management
 * client can respect it rather than guess at it (#422).
 *
 * Every case below is about one of the two things that would make the seam worse than nothing. A fact a
 * client cannot name is a fact it renders as a guess, so a value with no declaration beside it is
 * refused at assembly and dropped on the way out. And a fact that disagrees with the capability's own
 * config is a lie a client believes, so a value outside its declared choices never gets built.
 */

/** A key as a capability writes one, before parsing. */
type KeyInput = z.input<typeof ManifestConfigKey>;

/** The first configured fact the kit ships: what a project bills. */
const billingSubject: KeyInput = {
  key: "billingSubject",
  choices: ["user", "organization"],
  summary: "What kind of thing holds a purchase in this project — one person, or one organization.",
};

/** A second, with no closed list: a fact whose values nobody can enumerate ahead of time. */
const basePath: KeyInput = {
  key: "basePath",
  choices: null,
  summary: "Where this capability's routes are mounted.",
};

describe("a declaration says what a fact may be, and the factory refuses anything else", () => {
  test("a key with a closed list carries its values, and one without carries null", () => {
    const declared = defineManifestConfig({
      keys: [billingSubject, basePath],
      values: { billingSubject: "organization", basePath: "/billing" },
    });
    expect(declared.keys.map((key) => key.key)).toEqual(["billingSubject", "basePath"]);
    expect(declared.keys[0]?.choices).toEqual(["user", "organization"]);
    expect(declared.keys[1]?.choices).toBeNull();
    expect(declared.values).toEqual({ billingSubject: "organization", basePath: "/billing" });
  });

  test("a number and a boolean are facts too, so a fact is not always a word", () => {
    const declared = defineManifestConfig({
      keys: [
        { key: "trialDays", choices: null, summary: "How long a trial lasts." },
        { key: "proration", choices: null, summary: "Whether a plan change is prorated." },
      ],
      values: { trialDays: 14, proration: true },
    });
    expect(declared.values).toEqual({ trialDays: 14, proration: true });
  });

  test("a declaration with no keys is refused — an empty vocabulary states no fact", () => {
    expect(() => defineManifestConfig({ keys: [], values: {} })).toThrow(PithyError);
  });

  test("a value nothing declares is refused, because a client could only guess at it", () => {
    expect(() =>
      defineManifestConfig({
        keys: [billingSubject],
        values: { billingSubject: "user", stripeSecretKey: "sk_live_hunter2" },
      }),
    ).toThrow(PithyError);
  });

  test("and the refusal names the key, because the fix is in the capability that wrote it", () => {
    try {
      defineManifestConfig({ keys: [billingSubject], values: { billingSubject: "user", rails: "apple" } });
      expect.unreachable("the factory accepted a value nothing declares");
    } catch (error) {
      expect((error as PithyError).payload.detail).toContain("rails");
    }
  });

  test("a value that is not a scalar is refused, which is the rule the type states first", () => {
    // Unreachable through the types — `ManifestConfigValues` admits a string, a number or a boolean and nothing
    // else — so this stands for the untyped caller and for the day somebody widens the union. A config
    // object here is how an adopter's catalog would reach a discovery read.
    const bag = { keys: [basePath], values: { basePath: { mounted: "/billing" } } } as unknown as Parameters<
      typeof defineManifestConfig
    >[0];
    expect(() => defineManifestConfig(bag)).toThrow(PithyError);
  });

  test("a declared key with no value is refused — a declaration is a promise", () => {
    // The failure this prevents is the worst-looking one: a client reads the declaration, renders a
    // control for the fact, and finds nothing behind it. Absence would be indistinguishable from a
    // Worker too old to know the key.
    expect(() => defineManifestConfig({ keys: [billingSubject], values: {} })).toThrow(PithyError);
  });

  test("and a key named after something on Object.prototype is refused the same way", () => {
    // The camelCase pattern matches `toString`, `valueOf`, `constructor` and `hasOwnProperty`, and
    // `ManifestConfigValues` parses to a plain object — so `values[key.key]` for a key nobody stated reads a
    // function off the prototype, calls it a value, and lets the declaration through with nothing behind
    // it. The one guard that exists is the one this would slip.
    for (const key of ["toString", "valueOf", "constructor", "hasOwnProperty"]) {
      expect(() =>
        defineManifestConfig({ keys: [{ key, choices: null, summary: "A fact nobody stated." }], values: {} }),
      ).toThrow(PithyError);
    }
  });

  test("a closed list with nothing in it is refused by the declaration, not by the value", () => {
    // `choices: []` reads as "no closed list" and means the opposite: nothing satisfies it, so the
    // capability can never boot whatever it states. Refused where the mistake is — an author who meant
    // "not enumerable" wrote the wrong one of `[]` and `null`, and the value is not the evidence.
    expect(ManifestConfigKey.safeParse({ ...billingSubject, choices: [] }).success).toBe(false);
    try {
      defineManifestConfig({ keys: [{ ...billingSubject, choices: [] }], values: { billingSubject: "user" } });
      expect.unreachable("the factory accepted a closed list nothing can satisfy");
    } catch (error) {
      // The declaration's refusal, which names the fix. The value check's would have read "`user`, which
      // is not one of " and named nothing at all.
      const { detail } = (error as PithyError).payload;
      expect(detail).toContain("is invalid");
      expect(detail).not.toContain("which is not one of ");
    }
  });

  test("a value outside its closed list is refused", () => {
    // The one check standing between a declaration and the capability's real config. Nothing downstream
    // compares the two — they come from the same object — so the choices are where a typo dies.
    expect(() => defineManifestConfig({ keys: [billingSubject], values: { billingSubject: "org" } })).toThrow(
      PithyError,
    );
  });

  test("a key with no closed list takes any scalar, which is what null means", () => {
    expect(defineManifestConfig({ keys: [basePath], values: { basePath: "/anything" } }).values).toEqual({
      basePath: "/anything",
    });
  });

  test("the same key twice is refused — the second silently decides what the first meant", () => {
    expect(() =>
      defineManifestConfig({ keys: [billingSubject, { ...billingSubject }], values: { billingSubject: "user" } }),
    ).toThrow(PithyError);
  });

  test("a key that is not one camelCase token is refused, so a fact never reads as a path or an id", () => {
    for (const key of ["billing_subject", "Billing", "billing.subject", "billing subject", ""]) {
      expect(() => defineManifestConfig({ keys: [{ ...billingSubject, key }], values: { [key]: "user" } })).toThrow(
        PithyError,
      );
    }
  });

  test("a declaration that skipped the factory does not compile", () => {
    // The gate, and it is the compiler rather than a runtime check: the seam is branded, so the only way
    // to build one is through the factory that parses it. Delete the brand and the directive below stops
    // being needed, which `bun run typecheck` reports as an unused `@ts-expect-error` — so this test
    // fails the build the moment the door stops being the only door.
    const sneaky = defineCapability({
      name: "sneaky",
      requiredBindings: [],
      // @ts-expect-error — an inline literal is not a parsed declaration, and nothing may reach a
      // manifest without having been parsed.
      manifestConfig: { keys: [ManifestConfigKey.parse(billingSubject)], values: { billingSubject: "user" } },
    });
    expect(sneaky.name).toBe("sneaky");
  });
});

describe("a client renders an unknown fact as nothing", () => {
  const declared = [ManifestConfigKey.parse(billingSubject)];

  test("a value with no declaration beside it is dropped rather than guessed at", () => {
    // What an older client meets against a newer Worker. The whole manifest parses — `ManifestConfigValues`
    // tolerates a key it has never heard of — and the pairing is where the unknown one stops, because a
    // fact with no summary and no choices is not renderable at all.
    expect(
      namedConfigValues({ configKeys: declared, config: { billingSubject: "organization", region: "eu" } }),
    ).toEqual([{ key: declared[0], value: "organization" }]);
  });

  test("a declared key with no value beside it names nothing, rather than naming undefined", () => {
    // Not a shape the factory produces. It is the shape a *later* change would produce if withholding a
    // fact per scope is ever added, and the pairing already survives it.
    expect(namedConfigValues({ configKeys: declared, config: {} })).toEqual([]);
  });

  test("a capability that declares nothing names nothing", () => {
    expect(namedConfigValues({ configKeys: [], config: {} })).toEqual([]);
  });

  test("a declared key named after something on Object.prototype names nothing either", () => {
    // The client half of the same hole. `config[key.key]` would hand back `Object.prototype.toString`,
    // and the pair would carry a function where the type promises a scalar — so a client renders a fact
    // that was never stated, off a value that is not one.
    const inherited = ManifestConfigKey.parse({ key: "toString", choices: null, summary: "A fact nobody stated." });
    expect(namedConfigValues({ configKeys: [inherited], config: {} })).toEqual([]);
  });
});
