// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { I18nConfig, type I18nConfigInput } from "../config/config";
import { applyDocumentLocale, readBrowserSignals, rememberBrowserLocale } from "./signals";

/**
 * The four signals a page can read for itself, and the two attributes it writes back.
 *
 * **This half of the package had no test at all until #441's verification pass, and that is the finding
 * rather than the fix.** `readBrowserSignals` was gutted to return all-nulls and `applyDocumentLocale`
 * to a no-op, and every one of the 130 tests in this package still passed — because every one of them
 * ran in node, where `window` and `document` do not exist and nothing could have noticed. A module
 * that only a browser can execute needs a suite that only a browser can run.
 *
 * So these cases are the ones a node test cannot state. Not "does the chain prefer the query string" —
 * `resolve/browser.test.ts` owns that, purely, and rightly. These are the reads themselves: what
 * `localStorage` does in a private window, what `document.documentElement.lang` says before the first
 * paint, and what happens when there is no document to read at all.
 */

const config = (input: I18nConfigInput = {}): I18nConfig => I18nConfig.parse(input);

/**
 * A browser that refuses storage: a private window, a site-data block, an embedded view.
 *
 * The whole global is replaced rather than one method spied on. happy-dom serves `localStorage` through
 * a proxy, and `vi.restoreAllMocks()` does not undo a spy installed on one — the throw leaks into every
 * later case in the file, which is how this shape was found. `vi.unstubAllGlobals()` does undo it.
 */
/**
 * The reader's browser languages, pinned.
 *
 * Stubbed in every case rather than left to happy-dom, which reports `en-US`. `navigator` is a link of
 * the chain now, so a test that inherits whatever the environment happens to say is a test whose
 * subject moves when the environment updates.
 */
function speaks(...languages: string[]) {
  vi.stubGlobal("navigator", { ...window.navigator, languages, language: languages[0] ?? "en" });
}

function blockStorage() {
  const refuse = () => {
    throw new Error("The operation is insecure.");
  };
  const storage = { getItem: vi.fn(refuse), setItem: vi.fn(refuse), removeItem: vi.fn(refuse), clear: vi.fn(refuse) };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

/**
 * Put the page at `path`, so the `query` signal has something real to read.
 *
 * `history.replaceState` rather than assigning `location.href`: assigning navigates, and a navigation
 * in happy-dom tears the document down under the test that is reading it.
 */
function at(path: string): void {
  window.history.replaceState({}, "", path);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.lang = "";
  document.documentElement.dir = "";
  at("/");
});

describe("what the page can see", () => {
  test("reads the query parameter, this device's memory, and the server's answer", () => {
    at("/?lang=es");
    window.localStorage.setItem("pithy.locale", "fr");
    document.documentElement.lang = "de";
    speaks("pt-BR", "pt");
    expect(readBrowserSignals(config())).toEqual({
      query: "es",
      storage: "fr",
      navigator: ["pt-BR", "pt"],
      server: "de",
    });
  });

  test("each name is the configured one, never a literal", () => {
    // The whole reason a scaffolded `client.tsx` calls into the package rather than reading the two
    // globals itself: a project that renamed either key must not need the front end rewritten.
    at("/?hl=es");
    window.localStorage.setItem("app.lang", "fr");
    const renamed = config({ queryParam: "hl", storageKey: "app.lang" });
    expect(readBrowserSignals(renamed)).toMatchObject({ query: "es", storage: "fr" });
    // And the defaults find nothing, so it is the configured name answering rather than both.
    expect(readBrowserSignals(config())).toMatchObject({ query: null, storage: null });
  });

  test("a signal nothing wrote is `null`, not an empty string", () => {
    // `document.documentElement.lang` is `""` on a document nobody set it on, and `""` is a language
    // range the matcher would be asked to resolve. The `|| null` in the read is what stops that.
    speaks();
    expect(readBrowserSignals(config())).toEqual({ query: null, storage: null, navigator: null, server: null });
  });

  test("`account` is not among them, because the page does not know", () => {
    // There is no session before a render. Merging it in is the call site's job, which is what keeps
    // `pithy_auth_users.locale` the one home for a person's language.
    expect("account" in readBrowserSignals(config())).toBe(false);
  });
});

describe("a browser that refuses storage", () => {
  test("`localStorage` throwing on read is `null`, not a crash", () => {
    // A private window, a site-data block, an embedded view. This throws on *access* in real browsers,
    // and an unguarded read takes the whole first paint with it.
    at("/?lang=es");
    blockStorage();
    speaks();
    expect(readBrowserSignals(config())).toEqual({ query: "es", storage: null, navigator: null, server: null });
  });

  test("`localStorage` throwing on write is silent — a preference is not worth a throw", () => {
    const storage = blockStorage();
    expect(() => rememberBrowserLocale("es", config())).not.toThrow();
    expect(storage.setItem).toHaveBeenCalledWith("pithy.locale", "es");
  });

  test("a remembered locale is written under the configured key", () => {
    rememberBrowserLocale("es", config({ storageKey: "app.lang" }));
    expect(window.localStorage.getItem("app.lang")).toBe("es");
    expect(window.localStorage.getItem("pithy.locale")).toBeNull();
  });
});

describe("no document at all", () => {
  test("every signal answers `null` rather than throwing", () => {
    // A server render, and every test environment that is not a browser. `document` is not merely
    // empty here, it is absent — which is the case a `document.documentElement` guard would miss.
    vi.stubGlobal("document", undefined);
    expect(() => readBrowserSignals(config())).not.toThrow();
    expect(readBrowserSignals(config()).server).toBeNull();
  });

  test("applying a locale is a no-op rather than a throw", () => {
    vi.stubGlobal("document", undefined);
    expect(() => applyDocumentLocale("es", "rtl")).not.toThrow();
  });

  test("no `window` either — the storage and query reads survive it", () => {
    vi.stubGlobal("window", undefined);
    // `navigator` is read off `window` too, so it goes with it — which is the case that matters, since
    // a server render has no window and must not throw reaching for the reader's languages.
    expect(readBrowserSignals(config())).toEqual({ query: null, storage: null, navigator: null, server: null });
    expect(() => rememberBrowserLocale("es", config())).not.toThrow();
  });
});

describe("what the page writes back", () => {
  test("`lang` and `dir` both land on the document element", () => {
    // The one thing no catalog can do and every screen needs: assistive technology, hyphenation and the
    // browser's own text handling all read `lang`, and `dir` is what makes a right-to-left locale lay
    // out at all. `templates/index.html` ships `lang="en"` as static text, so this is the only hook.
    applyDocumentLocale("es", "ltr");
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
  });

  test("a right-to-left reader gets the rtl direction", () => {
    applyDocumentLocale("ar", "rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  test("applying twice replaces rather than accumulates", () => {
    applyDocumentLocale("ar", "rtl");
    applyDocumentLocale("en", "ltr");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
