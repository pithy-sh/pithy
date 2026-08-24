// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { I18nConfig, type I18nConfigInput } from "../config/config";
import { resolveBrowserLocale } from "./browser";

/**
 * The browser chain — a separate chain from the server's, over the same `resolveChain`.
 *
 * Separate because half of each side's links do not exist on the other: `localStorage` is absent from a
 * Worker, and `navigator.language` inside workerd is the constant `"en"`, which carries no request
 * information at all. Two chains over one contract is honest; one chain with half its links inert is not.
 */

const config = (input: I18nConfigInput = {}): I18nConfig => I18nConfig.parse(input);

/** Four supported languages, so each link can ask for a different one and the winner is unambiguous. */
const POLYGLOT = config({ supportedLocales: ["en", "es", "fr", "de"], defaultLocale: "en" });

/** One signal per link, each naming a different language. */
const ALL_FOUR = { query: "es", account: "fr", storage: "de", server: "en" } as const;

describe("the documented default order", () => {
  test("`?lang=` beats everything", () => {
    const resolved = resolveBrowserLocale(ALL_FOUR, POLYGLOT);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("query");
  });

  test("the account is next", () => {
    const resolved = resolveBrowserLocale({ ...ALL_FOUR, query: null }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("fr");
    expect(resolved.resolvedBy).toBe("account");
  });

  test("local storage is third", () => {
    const resolved = resolveBrowserLocale({ ...ALL_FOUR, query: null, account: null }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("de");
    expect(resolved.resolvedBy).toBe("storage");
  });

  test("what the server negotiated is fourth", () => {
    const resolved = resolveBrowserLocale({ server: "en" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("en");
    expect(resolved.resolvedBy).toBe("server");
  });

  test("nothing at all is the project default", () => {
    expect(resolveBrowserLocale({}, POLYGLOT).resolvedBy).toBe("default");
  });
});

describe("the account outranks the device", () => {
  test("a signed-in reader's account beats what this device remembers", () => {
    // **The one home for this fact.** `pithy_auth_users.locale` is where a person's locale lives, so a
    // reader who picks Spanish on their phone must not be reading French on their laptop because that
    // laptop's `localStorage` still holds an older choice. Inverting these two is not a preference
    // between two defensible orders — it is the bug where one person has as many languages as devices,
    // and the newest choice is not the one that wins.
    //
    // The `?lang=` link stays above both on purpose: a reader switching language on one page expects
    // that page to switch. What keeps it from splitting the two again is that a signed-in reader's
    // `?lang=` is written through to their account, not only to `localStorage`.
    const resolved = resolveBrowserLocale({ account: "es", storage: "de" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("account");
  });

  test("with no account signed in, the device's memory answers", () => {
    const resolved = resolveBrowserLocale({ account: null, storage: "de" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("de");
    expect(resolved.resolvedBy).toBe("storage");
  });

  test("an account locale the project no longer serves does not sink the device's", () => {
    const resolved = resolveBrowserLocale({ account: "ja", storage: "de" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("de");
  });
});

describe("the order is configuration here too", () => {
  test("reordering `browserResolvers` changes the answer", () => {
    const storageFirst = config({
      supportedLocales: ["en", "es", "fr", "de"],
      defaultLocale: "en",
      browserResolvers: ["storage", "query", "account", "server", "default"],
    });
    const signals = { query: "es", storage: "de" };
    expect(resolveBrowserLocale(signals, POLYGLOT).catalogLocale).toBe("es");
    expect(resolveBrowserLocale(signals, storageFirst).catalogLocale).toBe("de");
  });
});

describe("the two locales, in the browser too", () => {
  test("a stored `es-AR` reads the `es` catalog and formats as `es-AR`", () => {
    const resolved = resolveBrowserLocale({ storage: "es-AR" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.formattingLocale).toBe("es-AR");
  });

  test("a corrupted `localStorage` value is skipped rather than thrown on", () => {
    // `localStorage` is reader-writable in every browser's console, so its value is untrusted input on
    // exactly the same footing as an `Accept-Language` header.
    expect(() => resolveBrowserLocale({ storage: "en_US", server: "fr" }, POLYGLOT)).not.toThrow();
    expect(resolveBrowserLocale({ storage: "en_US", server: "fr" }, POLYGLOT).catalogLocale).toBe("fr");
  });
});

describe("a first-time visitor is answered by their own browser", () => {
  /**
   * **The link the chain was missing, and the gap it left.**
   *
   * `server` reads `document.documentElement.lang`, and a scaffolded SPA is served from a static
   * `index.html` that says `lang="en"` with no substitution token. So without a browser link, a
   * first-time Spanish visitor to a project shipping `es` — nothing chosen, nothing stored, nobody
   * signed in — resolved to the default and read English on every screen. Automatic negotiation
   * worked on the server and nowhere else, which is not what the capability claims.
   */
  const SERVES_ES = config({ supportedLocales: ["en", "es"], defaultLocale: "en" });

  test("the browser's languages answer when nothing else does", () => {
    const resolved = resolveBrowserLocale({ navigator: ["es-AR", "es", "en"] }, SERVES_ES);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.formattingLocale).toBe("es-AR");
    expect(resolved.resolvedBy).toBe("navigator");
  });

  test("it outranks a `lang` the document only ever declared statically", () => {
    // The whole point of the ordering: `server` is `en` for every scaffolded SPA, so ranked above the
    // browser it would answer for everyone and the link would be decorative.
    const resolved = resolveBrowserLocale({ navigator: ["es"], server: "en" }, SERVES_ES);
    expect(resolved.catalogLocale).toBe("es");
  });

  test("and the reader's own choices still outrank the browser", () => {
    expect(resolveBrowserLocale({ query: "en", navigator: ["es"] }, SERVES_ES).catalogLocale).toBe("en");
    expect(resolveBrowserLocale({ account: "en", navigator: ["es"] }, SERVES_ES).catalogLocale).toBe("en");
    expect(resolveBrowserLocale({ storage: "en", navigator: ["es"] }, SERVES_ES).catalogLocale).toBe("en");
  });

  test("the whole weighted list is walked, so a second language still answers", () => {
    // `navigator.languages` is already in preference order. A reader whose first language the project
    // does not ship gets their second, rather than the project default.
    const resolved = resolveBrowserLocale({ navigator: ["pt-PT", "es", "en"] }, SERVES_ES);
    expect(resolved.catalogLocale).toBe("es");
  });

  test("an empty or absent list contributes nothing rather than answering", () => {
    expect(resolveBrowserLocale({ navigator: [] }, SERVES_ES).resolvedBy).toBe("default");
    expect(resolveBrowserLocale({ navigator: null }, SERVES_ES).resolvedBy).toBe("default");
  });
});
