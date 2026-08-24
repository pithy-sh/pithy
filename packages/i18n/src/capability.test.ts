// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { lookupMessage, messageDomain } from "@pithy-sh/core/src/i18n/catalog";
import { describe, expect, test } from "vitest";
import { i18n, isI18nCapability } from "./capability";
import { KIT_CATALOGS } from "./catalogs/kit";
import { PACKAGE_VERSION } from "./version.generated";

/**
 * What the capability contributes, and — as much of the point — what it does not.
 *
 * This is the stateless shape `@pithy-sh/turnstile` has: one middleware and nothing else. Every
 * "declares no X" case below is a real property rather than a formality, because each X it declined
 * would cost an adopter something permanent — a table in their database, a migration order that can
 * never be renumbered, a binding their `wrangler.jsonc` has to carry, a reserved error domain they can
 * never write a code under.
 */

/** A capability contributing messages under its own domain, so `compose` has something to merge. */
const board: Capability = defineCapability({
  name: "board",
  messages: {
    en: { "board/nav.settings": "Settings" },
    es: { "board/nav.settings": "Ajustes" },
  },
  requiredBindings: [],
});

describe("what it declares", () => {
  const capability = i18n();

  test("its name is the one `pithy add i18n` uses", () => {
    expect(capability.name).toBe("i18n");
  });

  test("it carries its own stamped package version", () => {
    // Never `null` — that is reserved for the adopter's own `app` capability. A published package
    // reporting `null` is indistinguishable from adopter code in the control-plane manifest.
    expect(capability.version).toBe(PACKAGE_VERSION);
    expect(capability.version).not.toBeNull();
  });

  test("it contributes exactly one middleware, and no routes", () => {
    expect(capability.middleware).toHaveLength(1);
    expect(capability.routes).toBeUndefined();
    expect(capability.adminRoutes).toBeUndefined();
  });

  test("it declares no databases, no tables and no migrations", () => {
    // No `databases` slice means no tables, no migration namespace, and no `<NAME>_MIGRATION_ORDER` to
    // allocate — an order is stable forever once released, so not needing one is worth asserting.
    expect(capability.databases).toBeUndefined();
    expect(capability.kvNamespaces).toBeUndefined();
    expect(capability.seeds).toBeUndefined();
    expect(capability.workflows).toBeUndefined();
  });

  test("it declares no bindings", () => {
    expect(capability.requiredBindings).toEqual([]);
  });

  test("it reserves no error domain", () => {
    // Deliberate, and repo-wide rather than local: the moment an `i18n/*` code entered
    // `KitErrorPayload`, the whole `i18n` domain would be reserved against adopters — and `i18n` is a
    // generic enough word that somebody has already declared `i18n/missing_catalog` of their own.
    // Nothing here needs a code `core/*` and `validation/*` do not already carry.
    const domains = KitErrorPayload.options.map((option) => messageDomain(String(option.shape.code.value)));
    expect(domains).not.toContain("i18n");
  });

  test("it declares a settings check and a client projection", () => {
    expect(typeof capability.settings?.local).toBe("function");
    // Catalog coverage is `pithy doctor`'s local tier, not a `pithy i18n check` command.
    expect(capability.settings?.account).toBeUndefined();
    expect(typeof capability.client).toBe("function");
  });

  test("the resolved config is attached, defaults and all", () => {
    expect(capability.i18nConfig.supportedLocales).toEqual(["en"]);
    expect(capability.i18nConfig.defaultLocale).toBe("en");
  });
});

describe("the five layers, in the documented order", () => {
  /**
   * A fresh capability per case.
   *
   * `compose` mutates the instance it was called on, so a shared one would make each case depend on
   * the order the ones above it ran in — which is exactly the kind of coupling a suite should not have
   * to reason about.
   */
  const bilingual = () =>
    i18n({
      supportedLocales: ["en", "es"],
      defaultLocale: "en",
      messages: {
        es: { "app/greeting": "Buenas." },
        en: { "app/greeting": "Hi." },
      },
    });

  test("before `compose`, the two capability layers are empty and the adopter's are not", () => {
    // A capability sees only itself when it is constructed, so the kit's English is not here yet. The
    // layer *slots* are, which is what keeps the order fixed rather than growing at assembly.
    const layers = bilingual().layersFor("es");
    expect(layers).toHaveLength(6);
    expect(layers[0]).toEqual({ "app/greeting": "Buenas." });
    expect(layers[1]).toEqual({ "app/greeting": "Hi." });
    expect(layers[2]).toBe(KIT_CATALOGS.es);
    expect(layers[3]).toBeUndefined();
    expect(layers[4]).toBeUndefined();
    // Six, not five, since #442: English is its own layer rather than something the project-default
    // layer resolves to when nothing else contributed that locale.
    expect(layers[5]).toBeUndefined();
  });

  test("after `compose`, the capability layers carry every capability's own messages", () => {
    const capability = bilingual();
    capability.compose?.({ capabilities: [board, capability] });
    const layers = capability.layersFor("es");
    expect(layers).toHaveLength(6);
    // 1. the adopter's catalog for the resolved locale
    expect(layers[0]).toEqual({ "app/greeting": "Buenas." });
    // 2. the adopter's catalog for the project default
    expect(layers[1]).toEqual({ "app/greeting": "Hi." });
    // 3. the kit's translation for the resolved locale
    expect(layers[2]).toBe(KIT_CATALOGS.es);
    // 4. every composed capability's messages for the resolved locale
    expect(layers[3]).toEqual({ "board/nav.settings": "Ajustes" });
    // 5. that same set for the project default
    expect(layers[4]).toEqual({ "board/nav.settings": "Settings" });
    expect(capability.composedMessages.en).toEqual({ "board/nav.settings": "Settings" });
  });

  test("a locale nobody translated still gets the default-locale layers behind it", () => {
    const capability = bilingual();
    capability.compose?.({ capabilities: [board, capability] });
    const layers = capability.layersFor("fr");
    expect(layers[0]).toBeUndefined();
    expect(layers[1]).toEqual({ "app/greeting": "Hi." });
    expect(layers[2]).toBeUndefined();
    expect(layers[3]).toBeUndefined();
    expect(layers[4]).toEqual({ "board/nav.settings": "Settings" });
  });

  test("`compose` refuses a capability writing under somebody else's domain", () => {
    const trespasser: Capability = defineCapability({
      name: "board",
      messages: { en: { "auth/sign_in.title": "Sign in" } },
      requiredBindings: [],
    });
    const fresh = i18n({ supportedLocales: ["en"] });
    expect(() => fresh.compose?.({ capabilities: [trespasser, fresh] })).toThrow();
  });
});

describe("the client projection carries metadata and never catalogs", () => {
  test("it projects the negotiated set and nothing a reader would download twice", () => {
    const capability = i18n({ supportedLocales: ["en", "es"], messages: { es: { "app/greeting": "Buenas." } } });
    const projected = capability.client?.({ environment: "dev" });
    expect(projected).toEqual({
      enabled: true,
      supportedLocales: ["en", "es"],
      defaultLocale: "en",
      queryParam: "lang",
      storageKey: "pithy.locale",
      browserResolvers: ["query", "account", "storage", "navigator", "server", "default"],
      exceptions: {},
    });
    // The projection is inlined into the main chunk as a literal, so a catalog here would be
    // downloaded by every reader in every language before first paint.
    expect(JSON.stringify(projected)).not.toContain("Buenas.");
  });
});

describe("isI18nCapability", () => {
  test("it narrows the real capability", () => {
    const capability: Capability = i18n();
    expect(isI18nCapability(capability)).toBe(true);
    if (isI18nCapability(capability)) {
      // The narrowing is the point: `i18nConfig` and `layersFor` are only reachable through it.
      expect(capability.i18nConfig.defaultLocale).toBe("en");
      expect(capability.layersFor("en")).toHaveLength(6);
    }
  });

  test("it refuses another capability", () => {
    expect(isI18nCapability(board)).toBe(false);
  });

  test("it refuses an impostor that only shares the name", () => {
    // The name alone is not the test. A capability an adopter called `i18n` carries no resolved config
    // and no layer walk, and treating it as this one would fail at the first property read.
    const impostor: Capability = defineCapability({ name: "i18n", requiredBindings: [] });
    expect(isI18nCapability(impostor)).toBe(false);
  });
});

describe("English stays the backstop, whatever the project's default is", () => {
  /**
   * **A layer that reached English only by coincidence, until a capability shipped a second locale.**
   *
   * Layer 5 was `catalogFor(composedMessages, defaultLocale)` — `catalogs[default] ?? catalogs.en` —
   * which fell through to English only because no capability had ever contributed a non-`en` locale.
   * `@pithy-sh/email` does now (#442), so for a project whose default is not `en` the layer answered
   * the Spanish map, layers 5 and 6 collapsed into one, and an adopter's own English-only key rendered
   * as its raw key on a Spanish page. English is the language the kit is written in; it is a layer of
   * its own now rather than something another layer happens to resolve to.
   */
  function composed(defaultLocale: string) {
    const capability = i18n({ supportedLocales: ["en", "es"], defaultLocale });
    const app = defineCapability({
      name: "app",
      messages: { en: { "app/board.title": "Leaderboard" } },
      requiredBindings: [],
    });
    const withEmail = defineCapability({
      name: "email",
      messages: { en: { "email/x": "English" }, es: { "email/x": "Español" } },
      requiredBindings: [],
    });
    const all = [capability, withEmail, app];
    for (const one of all) one.compose?.({ capabilities: all });
    return capability;
  }

  test("an adopter's English-only key resolves on a Spanish page, default `en`", () => {
    const layers = composed("en").layersFor("es");
    expect(lookupMessage(layers, "app/board.title")).toBe("Leaderboard");
  });

  test("and it still resolves when the project's default is Spanish", () => {
    // The case that broke. Nothing about a project choosing a non-English default should cost it the
    // language the kit's own keys are written in.
    const layers = composed("es").layersFor("es");
    expect(lookupMessage(layers, "app/board.title")).toBe("Leaderboard");
  });

  test("a capability's own translation still wins over that backstop", () => {
    expect(lookupMessage(composed("es").layersFor("es"), "email/x")).toBe("Español");
    expect(lookupMessage(composed("es").layersFor("en"), "email/x")).toBe("English");
  });
});
