// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  decodeSubjectReference,
  encodeSubjectReference,
  MAX_SUBJECT_ID_LENGTH,
  PaymentsSubject,
  PaymentsSubjectType,
  sameSubject,
} from "./subject";

describe("PaymentsSubjectType", () => {
  test("is the closed pair, and nothing else decodes", () => {
    expect(PaymentsSubjectType.options).toEqual(["user", "organization"]);
    expect(PaymentsSubjectType.parse("user")).toBe("user");
    expect(PaymentsSubjectType.parse("organization")).toBe("organization");
  });

  test("refuses the British spelling, which is the one an adopter will reach for", () => {
    // Better Auth's plugin spells it with a z, and the stored column matches it. A row carrying the
    // other spelling is not a user and is not an organization — it fails to decode rather than being
    // read as either.
    expect(() => PaymentsSubjectType.parse("organisation")).toThrow();
  });

  test("refuses every other value rather than falling back to a user", () => {
    for (const bad of ["org", "Organization", "team", "USER", "", "user "]) {
      expect(() => PaymentsSubjectType.parse(bad)).toThrow();
    }
  });
});

describe("PaymentsSubject", () => {
  test("is the pair, and neither half is optional", () => {
    expect(PaymentsSubject.parse({ subjectType: "user", subjectId: "ada" })).toEqual({
      subjectType: "user",
      subjectId: "ada",
    });
    expect(() => PaymentsSubject.parse({ subjectId: "ada" })).toThrow();
    expect(() => PaymentsSubject.parse({ subjectType: "user" })).toThrow();
  });

  test("an empty id is not a subject", () => {
    expect(() => PaymentsSubject.parse({ subjectType: "user", subjectId: "" })).toThrow();
  });

  test("an id longer than the cap is refused, so an encoded reference always fits a provider field", () => {
    const id = "a".repeat(MAX_SUBJECT_ID_LENGTH);
    expect(PaymentsSubject.parse({ subjectType: "user", subjectId: id }).subjectId).toBe(id);
    expect(() => PaymentsSubject.parse({ subjectType: "user", subjectId: `${id}a` })).toThrow();
  });
});

describe("sameSubject", () => {
  test("compares both halves", () => {
    const ada = { subjectType: "user", subjectId: "ada" } as const;
    expect(sameSubject(ada, { subjectType: "user", subjectId: "ada" })).toBe(true);
    expect(sameSubject(ada, { subjectType: "user", subjectId: "grace" })).toBe(false);
  });

  test("one id under two types is two subjects — the whole point of the pair", () => {
    // Nothing in the kit keeps a user id and an organization id from colliding, so a comparison that
    // read only the id would let one grant the other's entitlements.
    expect(
      sameSubject({ subjectType: "user", subjectId: "acme" }, { subjectType: "organization", subjectId: "acme" }),
    ).toBe(false);
  });

  test("undefined is never the same as a subject, and not the same as itself", () => {
    // An unresolved owner must never compare equal to anything — that is a grant.
    expect(sameSubject(undefined, { subjectType: "user", subjectId: "ada" })).toBe(false);
    expect(sameSubject({ subjectType: "user", subjectId: "ada" }, undefined)).toBe(false);
    expect(sameSubject(undefined, undefined)).toBe(false);
  });
});

describe("encodeSubjectReference / decodeSubjectReference", () => {
  test("round-trips both types", () => {
    for (const subject of [
      { subjectType: "user", subjectId: "ada" },
      { subjectType: "organization", subjectId: "acme" },
    ] as const) {
      expect(decodeSubjectReference(encodeSubjectReference(subject))).toEqual(subject);
    }
  });

  test("the type half leads, so the encoding sorts and greps by kind", () => {
    expect(encodeSubjectReference({ subjectType: "user", subjectId: "ada" })).toBe("user:ada");
    expect(encodeSubjectReference({ subjectType: "organization", subjectId: "acme" })).toBe("organization:acme");
  });

  test("splits on the first separator only, so an id may contain one", () => {
    const subject = { subjectType: "organization", subjectId: "acme:eu:west" } as const;
    expect(encodeSubjectReference(subject)).toBe("organization:acme:eu:west");
    expect(decodeSubjectReference("organization:acme:eu:west")).toEqual(subject);
  });

  test("refuses anything that is not this encoding, rather than guessing a user", () => {
    // A bare id is the shape every pre-subject client sent. Reading it as a user would attribute a
    // stranger's purchase to whoever happens to hold that id.
    for (const bad of ["ada", "", ":", "user:", ":ada", "organisation:acme", "team:acme", "User:ada"]) {
      expect(decodeSubjectReference(bad)).toBeUndefined();
    }
  });

  test("refuses an id past the cap, so a truncated provider field never decodes to a shorter id", () => {
    expect(decodeSubjectReference(`user:${"a".repeat(MAX_SUBJECT_ID_LENGTH + 1)}`)).toBeUndefined();
  });

  test("an encoded reference fits the narrowest provider field the kit writes one into", () => {
    // Stripe's `client_reference_id` is the tightest at 200 characters, and a reference that did not
    // fit would be truncated by the provider and decode to a different subject.
    const longest = encodeSubjectReference({
      subjectType: "organization",
      subjectId: "a".repeat(MAX_SUBJECT_ID_LENGTH),
    });
    expect(longest.length).toBeLessThanOrEqual(200);
  });
});
