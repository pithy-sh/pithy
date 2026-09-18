// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { safeReason } from "@pithy-sh/core/src/error/cause";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { BetterAuthPlugin } from "better-auth";
// The barrel, and only for this one: `oauth-popup` has no `./plugins/oauth-popup` entry in
// `better-auth`'s export map, so the deep import every other plugin here uses does not resolve for it.
import { oauthPopup } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, test } from "vitest";
import { AuthPlugin, assertAdditivePlugins, KIT_PLUGIN_IDS, kitPlugins } from "./plugins";
import { PROVIDER_SIGN_IN_GATE_ID } from "./providerSignInGate";
import { REFUSED_PLUGIN_IDS } from "./refusalTransport";

/** The schema-only deps: `kitPlugins` reads them for lifetimes and delivery, never for identity. */
const deps = {
  verificationExpiresIn: 300,
  otpLength: 6,
  disableSignUp: false,
  sendEmail: async () => undefined,
  emit: async () => undefined,
};

describe("kitPlugins()", () => {
  test("composes exactly the set the kit promises, in a stable order", () => {
    // `i18n` leads, and the order is the point rather than a detail: it translates the refusals of the
    // plugins registered around it, so one composed ahead of it would answer in English regardless.
    expect(kitPlugins(deps).map((plugin) => plugin.id)).toEqual([
      "i18n",
      "bearer",
      "jwt",
      "magic-link",
      "email-otp",
      PROVIDER_SIGN_IN_GATE_ID,
    ]);
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

/**
 * Round 6 (#625): the plugin that answers a refusal somewhere the collapse cannot read.
 *
 * `collapseProviderRefusal` reads the `Location` header of the response `instance.handler()` returned.
 * `oauthPopup()`'s after hook replaces that response with an HTML page carrying the code in its body, so
 * the refusal leaves the Worker through a transport the collapse never looks at — with no malformed
 * input anywhere, which is why five rounds of input guarding could not reach it.
 *
 * The gate is at composition because that is the one moment the kit can still say no.
 */
describe("assertAdditivePlugins() refuses a plugin whose refusals the collapse cannot reach", () => {
  test("oauthPopup() is refused, naming the plugin", () => {
    expect(() => assertAdditivePlugins([oauthPopup()])).toThrow(ValidationError);
    try {
      assertAdditivePlugins([oauthPopup()]);
      throw new Error("expected a refusal");
    } catch (error) {
      const payload = (error as PithyError).payload;
      expect(payload.message).toContain("oauth-popup");
      // The refusal has to survive the config loader, which prints `message` and drops everything else.
      expect(safeReason(error)).toBeDefined();
      // And it has to say what the adopter loses, not merely that they may not have it.
      expect(`${payload.action}`).toMatch(/refus|sign-in|enumerat/i);
    }
  });

  test("it is refused beside plugins that are fine, and the fine ones are not the reason", () => {
    // Order matters only in that the message must name the offender. `multiSession()` is deliberately
    // here: it registers an after hook matching the callback too, and it is composable.
    expect(() => assertAdditivePlugins([organization(), multiSession(), oauthPopup()])).toThrow(/oauth-popup/);
  });

  test("every plugin the roster refuses is refused by the gate — the two cannot drift", () => {
    expect(REFUSED_PLUGIN_IDS.length).toBeGreaterThan(0);
    for (const id of REFUSED_PLUGIN_IDS) {
      expect(() => assertAdditivePlugins([{ id } as BetterAuthPlugin])).toThrow(ValidationError);
    }
  });

  test("a plugin that only reads the callback's response is still composable", () => {
    // The whole reason this gate is a roster and not a structural property. `multi-session`,
    // `one-time-token`, `last-login-method` and `anonymous` all claim the callback's response stage and
    // none of them moves a refusal off the `Location` header. See `./refusalTransport`.
    expect(() => assertAdditivePlugins([multiSession()])).not.toThrow();
  });
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
