// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { I18nClientProjection } from "../client/projection";
import { applyProjectedLocale } from "./document";

/**
 * The first pass: the document's opening language, before anything renders.
 *
 * **This is the one line every scaffolded `client.tsx` calls**, and until #441's verification pass it
 * had no test anywhere. Gutted to `return null` it broke every adopter's first paint and no suite in
 * the repository noticed, because nothing in the repository ran it against a document.
 *
 * A template is copied into an adopter's repository and never rewritten, so what this function does is
 * frozen on the day they scaffold. Two things in particular have to be right on that day and are
 * checked below: the guarded reads — `localStorage` throws in a private window — and the chain order,
 * which is the project's configuration rather than the front end's assumption.
 */

/** A composed project's projection, with the defaults `i18n()` would have projected. */
function projection(over: Partial<Extract<I18nClientProjection, { enabled: true }>> = {}): I18nClientProjection {
  return {
    enabled: true,
    supportedLocales: ["en", "es", "ar"],
    defaultLocale: "en",
    queryParam: "lang",
    storageKey: "pithy.locale",
    browserResolvers: ["query", "account", "storage", "navigator", "server", "default"],
    exceptions: {},
    ...over,
  };
}

/** Put the page at `path` without navigating — a navigation tears the document down mid-test. */
/**
 * The reader's browser languages, pinned.
 *
 * `navigator` is a link of the chain, and happy-dom reports `en-US` — so a case meaning "nothing but
 * the project default answers" has to say so rather than inherit whatever the environment says.
 */
function speaks(...languages: string[]) {
  vi.stubGlobal("navigator", { ...window.navigator, languages, language: languages[0] ?? "" });
}

function at(path: string): void {
  window.history.replaceState({}, "", path);
}

/**
 * A browser that refuses storage. The whole global is replaced rather than one method spied on:
 * happy-dom serves `localStorage` through a proxy, and `vi.restoreAllMocks()` does not undo a spy
 * installed on one, so the throw would leak into every later case in the file.
 */
function blockStorage(): void {
  const refuse = () => {
    throw new Error("The operation is insecure.");
  };
  vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse });
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = "";
  document.documentElement.dir = "";
  at("/");
});

describe("a project that never composed the capability", () => {
  test("answers `null` and leaves the document exactly as `index.html` shipped it", () => {
    // The whole reason the capability is optional. `templates/index.html` ships `lang="en"` as static
    // text; a disabled projection must not touch it, and must not claim a locale it did not negotiate.
    document.documentElement.lang = "en";
    expect(applyProjectedLocale({ enabled: false })).toBeNull();
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("");
  });
});

// Every case states the browser it is read by. Left to happy-dom it would be `en-US`, which is a
// signal — so a case about the *other* links would be answered by this one instead of by its subject.
beforeEach(() => {
  speaks();
});

describe("both locales, because only one of them falls back", () => {
  test("a regional reader reads the catalog we have and formats as the region they asked for", () => {
    // The collapse this pair exists to prevent, and it was reintroduced here once: this function
    // answered a single string, the scaffolded provider passed it as `catalogLocale` AND
    // `formattingLocale`, and an `es-AR` reader got Argentine dates from the Worker and
    // Spanish-from-Spain dates from the SPA — same account, same session.
    at("/?lang=es-AR");
    const resolved = applyProjectedLocale(projection());
    expect(resolved?.catalogLocale).toBe("es");
    expect(resolved?.formattingLocale).toBe("es-AR");
    // And `lang` carries the catalog locale, because that is the language of the words on the page.
    expect(document.documentElement.lang).toBe("es");
  });

  test("an extension subtag on `?lang=` never reaches Intl", () => {
    // A link somebody can send. `en-u-nu-hanidec` truncates to `en`, matches, and — carried whole —
    // renders every price in Han decimal numerals. Stripped, the reader gets what the project offered.
    at("/?lang=en-u-nu-hanidec");
    const resolved = applyProjectedLocale(projection());
    expect(resolved?.catalogLocale).toBe("en");
    expect(resolved?.formattingLocale).toBe("en");
    expect(new Intl.NumberFormat(resolved?.formattingLocale).format(1234)).toBe("1,234");
  });

  test("case is canonicalized, so `es-ar` reaches Intl as `es-AR`", () => {
    at("/?lang=es-ar");
    expect(applyProjectedLocale(projection())?.formattingLocale).toBe("es-AR");
  });

  test("a range that is not a constructible tag formats as the catalog locale", () => {
    // A wildcard matches, and there is no region in it to keep. Handing `*` to `Intl` throws.
    at("/?lang=*");
    const resolved = applyProjectedLocale(projection());
    expect(resolved?.formattingLocale).toBe(resolved?.catalogLocale);
    expect(() => new Intl.NumberFormat(resolved?.formattingLocale)).not.toThrow();
  });

  test("with nothing negotiated, the default answers both", () => {
    at("/");
    const resolved = applyProjectedLocale(projection());
    expect(resolved?.catalogLocale).toBe("en");
    expect(resolved?.formattingLocale).toBe("en");
  });
});

describe("the chain, walked in the projected order", () => {
  test("`?lang=` wins, and lands on the document", () => {
    at("/?lang=es");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
  });

  test("this device's memory answers when the URL is silent", () => {
    window.localStorage.setItem("pithy.locale", "es");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("es");
  });

  test("the server's `<html lang>` answers when neither does", () => {
    document.documentElement.lang = "es";
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("es");
  });

  test("the URL outranks the device, so switching language on one page works", () => {
    at("/?lang=en");
    window.localStorage.setItem("pithy.locale", "es");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("en");
  });

  test("the projected order is obeyed, not a hardcoded one", () => {
    // The reason the chain crosses the projection at all. A project that put storage first gets storage
    // first, and a front end that assumed the default order would answer `en` here.
    at("/?lang=en");
    window.localStorage.setItem("pithy.locale", "es");
    const reordered = projection({ browserResolvers: ["storage", "query", "default"] });
    expect(applyProjectedLocale(reordered)?.catalogLocale).toBe("es");
  });

  test("both key names are the projected ones", () => {
    at("/?hl=es");
    window.localStorage.setItem("app.lang", "ar");
    expect(applyProjectedLocale(projection({ queryParam: "hl", storageKey: "app.lang" }))?.catalogLocale).toBe("es");
    // And the defaults reach neither, so it is the projected name answering rather than both. The
    // `lang` the call above just wrote is cleared first: the `server` link would read it back and
    // answer `es` for a reason that has nothing to do with either key name.
    document.documentElement.lang = "";
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("en");
  });

  test("`account` contributes nothing here, and does not swallow the link behind it", () => {
    // There is no session before a render, and inventing one would be a second home for a fact
    // `pithy_auth_users.locale` owns. It stays in the walk so the configured order stays whole.
    window.localStorage.setItem("pithy.locale", "es");
    expect(
      applyProjectedLocale(projection({ browserResolvers: ["account", "storage", "default"] }))?.catalogLocale,
    ).toBe("es");
  });

  test("a resolver name this build does not know contributes nothing rather than throwing", () => {
    // `browserResolvers` arrives as `string[]`: the generated ambient declaration in an adopter's
    // Worker cannot name a type it does not import, so an older client meeting a newer project's
    // resolver has to walk past it.
    window.localStorage.setItem("pithy.locale", "es");
    const unknown = projection({ browserResolvers: ["telepathy", "storage", "default"] });
    expect(() => applyProjectedLocale(unknown)).not.toThrow();
    expect(applyProjectedLocale(unknown)?.catalogLocale).toBe("es");
  });

  test("nothing answering at all is the project default", () => {
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("what a reader can actually send", () => {
  test("a `?lang=` that is not a supported locale falls through rather than being served", () => {
    // The value is a query parameter — anybody can write anything in it. Every candidate is matched
    // against the projected set before it reaches the document, so an unsupported tag is skipped and
    // the link behind it still answers.
    at("/?lang=de");
    window.localStorage.setItem("pithy.locale", "es");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("es");
  });

  test("a hostile `?lang=` is the default locale and nothing else", () => {
    for (const value of ["%3Cscript%3E", "../../etc/passwd", "es'%20OR%201=1", "e".repeat(500), "en_US"]) {
      at(`/?lang=${value}`);
      expect(applyProjectedLocale(projection())?.catalogLocale, value).toBe("en");
      expect(document.documentElement.lang, value).toBe("en");
    }
  });

  test("a regional tag reads the catalog it has — `es-AR` is `es`", () => {
    at("/?lang=es-AR");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("es");
  });

  test("an exception the matcher could never derive is honored", () => {
    at("/?lang=nb");
    const historical = projection({ supportedLocales: ["en", "no"], exceptions: { nb: "no" } });
    expect(applyProjectedLocale(historical)?.catalogLocale).toBe("no");
  });
});

describe("direction, which is the half a reflow would show", () => {
  test("a right-to-left locale sets `dir` before the first paint", () => {
    // Doing this here as well as in `useNegotiatedLocale` is what keeps an Arabic reader from watching
    // the page lay out left-to-right and then flip.
    at("/?lang=ar");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  test("and a left-to-right one sets it back", () => {
    document.documentElement.dir = "rtl";
    at("/?lang=en");
    applyProjectedLocale(projection());
    expect(document.documentElement.dir).toBe("ltr");
  });
});

describe("a browser that refuses storage", () => {
  test("a throwing `localStorage` is a skipped link, not a blank page", () => {
    // A private window, a site-data block, an embedded view. Unguarded this throws out of the first
    // line of `client.tsx`, before anything has rendered.
    blockStorage();
    document.documentElement.lang = "es";
    expect(() => applyProjectedLocale(projection())).not.toThrow();
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("es");
  });
});

describe("a first-time visitor, read by their own browser", () => {
  /**
   * The pre-render pass, end to end. Nothing chosen, nothing stored, nobody signed in, and the
   * document saying `lang="en"` because that is what the scaffolded `index.html` ships — which is
   * every first visit to a scaffolded SPA. Before the `navigator` link, this resolved to the default
   * and the reader met English on every screen.
   */
  test("a Spanish browser gets Spanish, over the static `lang` the scaffold ships", () => {
    at("/");
    document.documentElement.lang = "en";
    speaks("es-AR", "es");
    const resolved = applyProjectedLocale(projection());
    expect(resolved?.catalogLocale).toBe("es");
    expect(resolved?.formattingLocale).toBe("es-AR");
    // And the document is corrected to what the page will actually say.
    expect(document.documentElement.lang).toBe("es");
  });

  test("a browser speaking nothing the project ships still gets the default", () => {
    at("/");
    speaks("ja-JP", "ja");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("en");
  });

  test("and a reader's own choice still outranks their browser", () => {
    at("/?lang=en");
    speaks("es");
    expect(applyProjectedLocale(projection())?.catalogLocale).toBe("en");
  });
});
