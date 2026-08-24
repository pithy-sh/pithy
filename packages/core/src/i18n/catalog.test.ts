// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { interpolate, lookupMessage, MessageKey, messageDomain } from "./catalog";

describe("MessageKey", () => {
  test("accepts an error code verbatim, because for an error the key is the code", () => {
    for (const key of ["auth/invalid_token", "core/upstream_timeout", "validation/invalid_input", "i18n/missing"]) {
      expect(MessageKey.safeParse(key).success, key).toBe(true);
    }
  });

  test("accepts a dotted screen path", () => {
    for (const key of ["auth/sign_in.title", "payments/pricing.buy.label"]) {
      expect(MessageKey.safeParse(key).success, key).toBe(true);
    }
  });

  test("refuses a key with no domain, or a domain that is not a capability name", () => {
    for (const key of ["title", "/title", "Auth/title", "auth-x/title", "auth//title", "auth/"]) {
      expect(MessageKey.safeParse(key).success, key).toBe(false);
    }
  });
});

describe("messageDomain", () => {
  test("is everything before the first slash", () => {
    expect(messageDomain("auth/sign_in.title")).toBe("auth");
    expect(messageDomain("core/not_found")).toBe("core");
  });
});

describe("interpolate", () => {
  test("substitutes each placeholder by name", () => {
    expect(interpolate("Renews {date}.", { date: "1 June" })).toBe("Renews 1 June.");
    expect(interpolate("We sent {n} digits to {email}.", { n: 6, email: "a@b.c" })).toBe("We sent 6 digits to a@b.c.");
  });

  test("leaves an unsupplied placeholder as written, because a blank reads like finished copy", () => {
    expect(interpolate("Renews {date}.", {})).toBe("Renews {date}.");
    expect(interpolate("Renews {date}.")).toBe("Renews {date}.");
  });

  test("substitutes booleans and numbers without stringifying the caller's job", () => {
    expect(interpolate("{a} {b}", { a: 0, b: false })).toBe("0 false");
  });

  test("leaves text with no placeholders untouched, braces included", () => {
    expect(interpolate("Add a {} block.", { x: 1 })).toBe("Add a {} block.");
  });
});

/**
 * The names every plain object inherits, read off `Object.prototype` rather than listed.
 *
 * Derived because the language owns this set, not this file: `constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `__proto__` and the rest. Read through a bare index every one of them is truthy
 * and none is a string, which is how `?lang=constructor` became a 500 on every request inside a global
 * middleware. Deriving it also means the two files that assert this property cannot drift apart, and
 * neither has to export anything for the other.
 */
const INHERITED = Object.getOwnPropertyNames(Object.prototype);

describe("lookupMessage", () => {
  const kit = { "auth/sign_in.title": "Welcome.", "auth/sign_in.email": "Email" };
  const adopter = { "auth/sign_in.title": "Hola." };

  test("walks per key, so one override does not fork the catalog", () => {
    expect(lookupMessage([adopter, kit], "auth/sign_in.title")).toBe("Hola.");
    expect(lookupMessage([adopter, kit], "auth/sign_in.email")).toBe("Email");
  });

  test("a key no layer has is null, not the empty string", () => {
    expect(lookupMessage([adopter, kit], "auth/sign_in.missing")).toBeNull();
  });

  test("an absent layer is skipped rather than ending the walk", () => {
    expect(lookupMessage([undefined, kit], "auth/sign_in.email")).toBe("Email");
  });

  test("an empty string is a message, not a miss", () => {
    expect(lookupMessage([{ "auth/x": "" }, kit], "auth/x")).toBe("");
  });
});

describe("an inherited name is not a message, and not a parameter", () => {
  test("no catalog answers a name it merely inherits", () => {
    // `layer["constructor"]` is `Object` itself. Returned, it hands a *function* to `interpolate`,
    // which calls `.replace` on it — so `t`, which is documented as total, throws instead.
    for (const name of INHERITED) {
      expect(lookupMessage([{}, { "auth/x": "real" }], name), name).toBeNull();
    }
  });

  test("an own key that happens to share the name still answers", () => {
    // The guard is `hasOwn`, not a deny-list: a catalog that really declares such a key is fine.
    expect(lookupMessage([{ toString: "written down" }], "toString")).toBe("written down");
  });

  test("no placeholder resolves through the prototype chain", () => {
    for (const name of INHERITED) {
      expect(interpolate(`Hello {${name}}`, { other: 1 }), name).toBe(`Hello {${name}}`);
    }
  });

  test("an own parameter that shares the name is still substituted", () => {
    expect(interpolate("Hello {toString}", { toString: "there" })).toBe("Hello there");
  });
});
