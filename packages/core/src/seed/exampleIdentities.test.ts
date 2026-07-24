import { describe, expect, test } from "vitest";
import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE, EXAMPLE_IDENTITIES } from "./exampleIdentities";

describe("EXAMPLE_IDENTITIES", () => {
  test("is a small, stable cast", () => {
    expect(EXAMPLE_IDENTITIES).toHaveLength(3);
    expect(EXAMPLE_IDENTITIES.map((identity) => identity.id)).toEqual(["example-ada", "example-grace", "example-alan"]);
  });

  test("ids are unique — they key user-owned rows across capabilities", () => {
    const ids = new Set(EXAMPLE_IDENTITIES.map((identity) => identity.id));
    expect(ids.size).toBe(EXAMPLE_IDENTITIES.length);
  });

  test("emails are unique and on the reserved example.com domain (never a real address)", () => {
    const emails = EXAMPLE_IDENTITIES.map((identity) => identity.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const email of emails) {
      expect(email.endsWith("@example.com")).toBe(true);
    }
  });

  test("every identity carries a display name", () => {
    for (const identity of EXAMPLE_IDENTITIES) {
      expect(identity.name.length).toBeGreaterThan(0);
    }
  });

  test("the named exports are the cast, in order", () => {
    expect([EXAMPLE_ADA, EXAMPLE_GRACE, EXAMPLE_ALAN]).toEqual([...EXAMPLE_IDENTITIES]);
  });
});
