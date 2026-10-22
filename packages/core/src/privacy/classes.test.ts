// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { PithyError } from "../error/pithyError";
import {
  BUILT_IN_PRIVACY_CLASSES,
  definePrivacyClass,
  maskPan,
  PrivacyClassName,
  pci,
  phi,
  pii,
  privacyClass,
  privacyClasses,
  secret,
  strongestPrivacyClass,
} from "./classes";

describe("the four built-in classes", () => {
  test("ship named, in a stable order, each with a description", () => {
    expect(BUILT_IN_PRIVACY_CLASSES).toEqual(["secret", "pii", "phi", "pci"]);
    for (const name of BUILT_IN_PRIVACY_CLASSES) {
      expect(privacyClass(name)?.description.length).toBeGreaterThan(20);
    }
  });

  test("mask to the `[class]` placeholder, except pci", () => {
    expect(privacyClass("pii")?.mask("ada@example.com")).toBe("[pii]");
    expect(privacyClass("phi")?.mask("asthma")).toBe("[phi]");
    expect(privacyClass("secret")?.mask("tok_123")).toBe("[secret]");
  });
});

describe("pii()", () => {
  test('reports `{ privacy: "pii" }` through `.meta()` and keeps the description, in either order', () => {
    const before = pii(z.string().describe("The address sign-in links are sent to."));
    expect(before.meta()).toMatchObject({ privacy: "pii", description: "The address sign-in links are sent to." });
    expect(before.description).toBe("The address sign-in links are sent to.");

    const after = pii(z.string()).describe("The address sign-in links are sent to.");
    expect(after.meta()).toMatchObject({ privacy: "pii", description: "The address sign-in links are sent to." });
    expect(after.description).toBe("The address sign-in links are sent to.");
  });

  test("keeps whatever meta the schema already carried", () => {
    const marked = pii(z.string().meta({ multiline: false }));
    expect(marked.meta()).toMatchObject({ privacy: "pii", multiline: false });
  });

  test("changes no runtime value: parse returns what it did before the marker", () => {
    const plain = z.object({ email: z.string().describe("e") }).describe("u");
    const marked = z.object({ email: pii(z.string().describe("e")) }).describe("u");
    const row = { email: "ada@example.com" };
    expect(marked.parse(row)).toEqual(plain.parse(row));
  });

  test("leaves the source schema unmarked", () => {
    const base = z.string().describe("e");
    pii(base);
    expect(base.meta()?.privacy).toBeUndefined();
  });

  test("the other three markers mark with their own class", () => {
    expect(phi(z.string()).meta()?.privacy).toBe("phi");
    expect(secret(z.string()).meta()?.privacy).toBe("secret");
    expect(pci(z.string()).meta()?.privacy).toBe("pci");
  });
});

describe("maskPan", () => {
  test("keeps the first six and the last four of a card number", () => {
    expect(maskPan("4242424242424242")).toBe("424242******4242");
    expect(maskPan("4242 4242 4242 4242")).toBe("424242******4242");
    expect(maskPan("3782-822463-10005")).toBe("378282*****0005");
  });

  test("is the placeholder for anything that is not a card number", () => {
    expect(maskPan("123")).toBe("[pci]");
    expect(maskPan("not a pan at all")).toBe("[pci]");
    expect(maskPan(4242424242424242)).toBe("[pci]");
  });

  test("is what the pci class masks with", () => {
    expect(privacyClass("pci")?.mask("4111111111111111")).toBe("411111******1111");
  });
});

describe("definePrivacyClass", () => {
  test("registers a class usable exactly like the built-ins", () => {
    const genetic = definePrivacyClass({ name: "genetic_test_a", mask: () => "[genome]" });
    const marked = genetic(z.string().describe("A sequenced marker."));
    expect(marked.meta()).toMatchObject({ privacy: "genetic_test_a", description: "A sequenced marker." });
    expect(genetic.className).toBe("genetic_test_a");
    expect(privacyClass("genetic_test_a")?.mask("ACGT")).toBe("[genome]");
    expect(privacyClasses().map((one) => one.name)).toContain("genetic_test_a");
  });

  test("defaults the mask to the `[class]` placeholder and states a description", () => {
    definePrivacyClass({ name: "biometric_test_b" });
    expect(privacyClass("biometric_test_b")?.mask("a face")).toBe("[biometric_test_b]");
    expect(privacyClass("biometric_test_b")?.description).toContain("biometric_test_b");
  });

  test("refuses a duplicate name at registration", () => {
    definePrivacyClass({ name: "duplicate_test_c" });
    expect(() => definePrivacyClass({ name: "duplicate_test_c" })).toThrow(PithyError);
    try {
      definePrivacyClass({ name: "duplicate_test_c" });
    } catch (error) {
      expect((error as PithyError).payload.code).toBe("core/conflict");
    }
  });

  test("refuses a built-in name", () => {
    expect(() => definePrivacyClass({ name: "pii" })).toThrow(PithyError);
  });

  test("refuses a name that is not a lowercase identifier", () => {
    expect(() => definePrivacyClass({ name: "Has Space" })).toThrow(PithyError);
  });
});

describe("PrivacyClassName", () => {
  test("is a lowercase identifier", () => {
    expect(PrivacyClassName.safeParse("phi").success).toBe(true);
    expect(PrivacyClassName.safeParse("genetic_data").success).toBe(true);
    expect(PrivacyClassName.safeParse("PHI").success).toBe(false);
    expect(PrivacyClassName.safeParse("").success).toBe(false);
  });
});

describe("strongestPrivacyClass", () => {
  test("ranks secret, then phi, then pci, then an adopter's class, then pii", () => {
    expect(strongestPrivacyClass(["pii", "phi", "secret"])).toBe("secret");
    expect(strongestPrivacyClass(["pii", "pci", "phi"])).toBe("phi");
    expect(strongestPrivacyClass(["pii", "pci"])).toBe("pci");
    expect(strongestPrivacyClass(["pii", "zeta_class", "alpha_class"])).toBe("alpha_class");
    expect(strongestPrivacyClass(["pii"])).toBe("pii");
    expect(strongestPrivacyClass([])).toBeUndefined();
  });
});

describe("a marker over another marker", () => {
  test("adds its class to the ones already there, in either order, and the same class twice is one", () => {
    const outer = pii(secret(z.string().describe("A token.")));
    const inner = secret(pii(z.string().describe("A token.")));
    expect(outer.meta()?.privacy).toEqual(["secret", "pii"]);
    expect(inner.meta()?.privacy).toEqual(outer.meta()?.privacy);
    expect(outer.meta()).toMatchObject({ description: "A token." });
    expect(pii(pii(z.string())).meta()?.privacy).toBe("pii");
    expect(phi(pii(secret(z.string()))).meta()?.privacy).toEqual(["secret", "phi", "pii"]);
  });

  test("adds an adopter's class the same way", () => {
    const genetic = definePrivacyClass({ name: "genetic_test_twice" });
    expect(pii(genetic(z.string())).meta()?.privacy).toEqual(["genetic_test_twice", "pii"]);
    expect(genetic(pii(z.string())).meta()?.privacy).toEqual(["genetic_test_twice", "pii"]);
  });
});
