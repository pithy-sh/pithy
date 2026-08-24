// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type Capability, defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import type { LocaleCatalogs } from "./catalog";
import { catalogFor, composeMessages } from "./registry";

function capability(name: string, messages?: LocaleCatalogs): Capability {
  return defineCapability({ name, messages, requiredBindings: [] });
}

describe("composeMessages", () => {
  test("merges every capability's contribution, keyed by locale", () => {
    const merged = composeMessages([
      capability("auth", { en: { "auth/sign_in.title": "Welcome." }, es: { "auth/sign_in.title": "Bienvenido." } }),
      capability("email", { en: { "email/magic_link.subject": "Your sign-in link" } }),
    ]);
    expect(merged).toEqual({
      en: { "auth/sign_in.title": "Welcome.", "email/magic_link.subject": "Your sign-in link" },
      es: { "auth/sign_in.title": "Bienvenido." },
    });
  });

  test("a capability contributing nothing is silent, which is the normal case", () => {
    expect(composeMessages([capability("auth"), capability("email")])).toEqual({});
  });

  test("refuses a key outside the contributing capability's own domain", () => {
    // The `pithy_<capability>_<table>` rule and the `auth/invalid_token` rule, for the third time: the
    // domain segment is what makes two capabilities' contributions incapable of colliding.
    expect(() => composeMessages([capability("email", { en: { "auth/sign_in.title": "Welcome." } })])).toThrow(
      PithyError,
    );
  });

  test("the refusal names the key, the contributor and the domain it wrote under", () => {
    try {
      composeMessages([capability("email", { en: { "auth/sign_in.title": "Welcome." } })]);
      expect.unreachable("the domain rule should have refused this");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.code).toBe("validation/invalid_input");
      expect(payload.action).toContain("email/");
      expect(payload.detail).toContain("auth/sign_in.title");
    }
  });

  test("the adopter's own app capability contributes under its own domain like anything else", () => {
    expect(composeMessages([capability("board", { en: { "board/nav.settings": "Settings" } })])).toEqual({
      en: { "board/nav.settings": "Settings" },
    });
  });

  test("composition order decides a collision, library before app", () => {
    // Only reachable between two capabilities sharing a name, which `createBackend` already refuses —
    // but the order is stated rather than incidental.
    const merged = composeMessages([
      capability("auth", { en: { "auth/x": "first" } }),
      capability("auth", { en: { "auth/x": "second" } }),
    ]);
    expect(merged.en?.["auth/x"]).toBe("second");
  });
});

describe("catalogFor", () => {
  const catalogs = { en: { "auth/x": "en" }, es: { "auth/x": "es" } };

  test("answers the locale asked for", () => {
    expect(catalogFor(catalogs, "es")).toEqual({ "auth/x": "es" });
  });

  test("falls back to English, which is what makes the capability optional", () => {
    expect(catalogFor(catalogs, "de")).toEqual({ "auth/x": "en" });
  });

  test("an empty registry is an empty catalog, never a throw", () => {
    expect(catalogFor({}, "es")).toEqual({});
  });
});

describe("an inherited name is not a locale", () => {
  test("a catalog set carrying an own `__proto__` key merges into the map, not through it", () => {
    // `Object.entries` really does return this: `JSON.parse` makes an own `__proto__` key, and a
    // capability's `messages` can arrive from parsed JSON. A bare `merged[locale] ??= {}` assigns
    // through the setter instead of into the map, and the locale is silently lost.
    const catalogs = JSON.parse('{"__proto__":{"auth/x":"through the setter"},"es":{"auth/x":"es"}}');
    const merged = composeMessages([capability("auth", catalogs)]);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.es?.["auth/x"]).toBe("es");
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    // And nothing leaked onto every object in the process.
    expect(({} as Record<string, unknown>)["auth/x"]).toBeUndefined();
  });
});
