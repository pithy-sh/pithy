// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { safeReason } from "@pithy-sh/core/src/error/cause";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, test } from "vitest";
import { AuthPlugin, assertAdditivePlugins, KIT_PLUGIN_IDS, kitPlugins } from "./plugins";

/** The schema-only deps: `kitPlugins` reads them for lifetimes and delivery, never for identity. */
const deps = {
  verificationExpiresIn: 300,
  otpLength: 6,
  disableSignUp: false,
  sendEmail: async () => undefined,
};

describe("kitPlugins()", () => {
  test("composes exactly the set the kit promises, in a stable order", () => {
    // `i18n` leads, and the order is the point rather than a detail: it translates the refusals of the
    // plugins registered around it, so one composed ahead of it would answer in English regardless.
    expect(kitPlugins(deps).map((plugin) => plugin.id)).toEqual(["i18n", "bearer", "jwt", "magic-link", "email-otp"]);
  });

  test("KIT_PLUGIN_IDS is what kitPlugins() actually returns — the guard cannot drift from the set", () => {
    expect(kitPlugins(deps).map((plugin) => plugin.id)).toEqual([...KIT_PLUGIN_IDS]);
  });

  test("jwt keeps the pithy-prefixed jwks model — a plugin list must not rename the kit's own table", () => {
    const jwtPlugin = kitPlugins(deps).find((plugin) => plugin.id === "jwt") as
      | { schema?: Record<string, { modelName?: string }> }
      | undefined;
    const schema = jwtPlugin?.schema;
    expect(schema?.jwks?.modelName).toBe("pithyAuthJwks");
  });
});

describe("assertAdditivePlugins()", () => {
  test("an ordinary plugin set passes", () => {
    expect(() => assertAdditivePlugins([organization(), admin()])).not.toThrow();
  });

  test("nothing to add passes", () => {
    expect(() => assertAdditivePlugins([])).not.toThrow();
  });

  test.each(KIT_PLUGIN_IDS)("refuses a plugin that would displace the kit's own %s, naming it", (id) => {
    const impostor = { id } as BetterAuthPlugin;
    expect(() => assertAdditivePlugins([impostor])).toThrow(PithyError);
    try {
      assertAdditivePlugins([impostor]);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const payload = (error as PithyError).payload;
      expect(payload.message).toContain(id);
      // The reason, not just the refusal: these four are what the rest of the kit verifies against.
      expect(payload.message.toLowerCase()).toContain("composes");
    }
  });

  test("refuses two adopter plugins sharing an id, naming it", () => {
    expect(() => assertAdditivePlugins([organization(), organization()])).toThrow(/organization/);
    expect(() => assertAdditivePlugins([organization(), organization()])).toThrow(ValidationError);
  });

  test.each([[[{ id: "magic-link" } as BetterAuthPlugin]], [[organization(), organization()]]])(
    "the refusal survives the config loader — its message is a reason `safeReason` will print",
    (plugins) => {
      // `auth()` runs while `pithy.config.ts` is being imported, so the CLI never sees this error object:
      // it sees whatever `safeReason` keeps. A message it drops reaches the adopter as "the config threw
      // while loading", which names nothing — which is the whole failure this refusal exists to avoid.
      try {
        assertAdditivePlugins(plugins);
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(safeReason(error)).toBeDefined();
      }
    },
  );
});

describe("AuthPlugin", () => {
  test("accepts a real plugin and hands back the very same object — a parsed plugin is still the plugin", () => {
    const plugin = organization();
    expect(AuthPlugin.parse(plugin)).toBe(plugin);
  });

  test.each([[null], [undefined], ["organization"], [{}], [{ id: "" }], [{ id: 7 }]])(
    "refuses %s — a plugin is an object with an id",
    (value) => {
      expect(() => AuthPlugin.parse(value)).toThrow();
    },
  );
});
