// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { I18nConfig, type I18nConfigInput } from "../config/config";
import { resolveServerLocale } from "./server";

/**
 * The server chain — what a Worker asks, and in what order.
 *
 * Two things are being held here. One is the documented order itself, which is a promise to an adopter
 * reading `docs/I18N.md` and is therefore asserted as literals rather than read back off the config.
 * The other is that the order is genuinely *configured* rather than baked: a chain that answered the
 * same regardless of `serverResolvers` would be a hard-coded walk with a decorative option beside it.
 */

const config = (input: I18nConfigInput = {}): I18nConfig => I18nConfig.parse(input);

/** Four supported languages, so each link of the chain can ask for a different one and be told apart. */
const POLYGLOT = config({ supportedLocales: ["en", "es", "fr", "de"], defaultLocale: "en" });

/** One signal per link, each naming a different language. Whichever comes back is the link that won. */
const ALL_FOUR = { param: "es", user: "fr", cookie: "de", header: "en" } as const;

describe("the documented default order", () => {
  test("param beats everything", () => {
    const resolved = resolveServerLocale(ALL_FOUR, POLYGLOT);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("param");
  });

  test("the account is next", () => {
    const resolved = resolveServerLocale({ ...ALL_FOUR, param: null }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("fr");
    expect(resolved.resolvedBy).toBe("user");
  });

  test("the cookie is third", () => {
    const resolved = resolveServerLocale({ ...ALL_FOUR, param: null, user: null }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("de");
    expect(resolved.resolvedBy).toBe("cookie");
  });

  test("`Accept-Language` is fourth", () => {
    const resolved = resolveServerLocale({ header: "en" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("en");
    expect(resolved.resolvedBy).toBe("header");
  });

  test("nothing at all is the project default", () => {
    const resolved = resolveServerLocale({}, POLYGLOT);
    expect(resolved.catalogLocale).toBe("en");
    expect(resolved.resolvedBy).toBe("default");
  });
});

describe("the order is configuration, not a walk with an option beside it", () => {
  test("reordering `serverResolvers` really changes the answer", () => {
    const signals = { param: "es", cookie: "de" };
    const cookieFirst = config({
      supportedLocales: ["en", "es", "fr", "de"],
      defaultLocale: "en",
      serverResolvers: ["cookie", "param", "user", "header", "default"],
    });
    expect(resolveServerLocale(signals, POLYGLOT).catalogLocale).toBe("es");
    expect(resolveServerLocale(signals, cookieFirst).catalogLocale).toBe("de");
    expect(resolveServerLocale(signals, cookieFirst).resolvedBy).toBe("cookie");
  });

  test("a link left out of the chain is never asked", () => {
    // An adopter who does not want a URL to override a signed-in reader drops `param`. The signal is
    // still supplied by the middleware; the chain simply has no link that reads it.
    const noParam = config({
      supportedLocales: ["en", "es", "fr"],
      defaultLocale: "en",
      serverResolvers: ["user", "cookie", "header", "default"],
    });
    const resolved = resolveServerLocale({ param: "es", user: "fr" }, noParam);
    expect(resolved.catalogLocale).toBe("fr");
    expect(resolved.resolvedBy).toBe("user");
  });

  test("a chain with no `default` link still falls through to the project default", () => {
    // `default` is the last resort whether or not it is listed — `resolveChain`'s own fallthrough,
    // not the link. An adopter who shortened the chain cannot accidentally leave a request unanswered.
    const shortened = config({ supportedLocales: ["en", "es"], defaultLocale: "es", serverResolvers: ["cookie"] });
    const resolved = resolveServerLocale({}, shortened);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("default");
  });
});

describe("`Accept-Language` is read as the whole weighted list", () => {
  test("`pt-PT;q=1.0, es;q=0.8, en;q=0.5` from a project with no Portuguese resolves to `es`", () => {
    // The case that makes reading only the header's first entry wrong. This reader speaks Portuguese
    // best and Spanish next; answering English because Portuguese is unavailable ignores what they said.
    const resolved = resolveServerLocale({ header: "pt-PT;q=1.0, es;q=0.8, en;q=0.5" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.formattingLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("header");
  });

  test("a region the project does not list still formats as the region", () => {
    const resolved = resolveServerLocale({ header: "es-AR,es;q=0.9,en;q=0.5" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.formattingLocale).toBe("es-AR");
  });

  test("`q=0` is a refusal, not a weak preference", () => {
    const resolved = resolveServerLocale({ header: "de;q=0, fr;q=0.4" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("fr");
  });
});

describe("a hostile or broken header falls back without throwing", () => {
  // Every one of these appears in real traffic, and `new Intl.Locale()` throws a `RangeError` on all
  // of them. A throw here is a 500 on a request that had a perfectly good default waiting for it.
  const BROKEN = ["en_US", "en_US, de_DE", "", ", , ,", ";q=0.9", "en_US;q=abc", "-", "1234", "x".repeat(5000)];

  test("none of them throws, and each lands on the project default", () => {
    for (const header of BROKEN) {
      expect(() => resolveServerLocale({ header }, POLYGLOT), header).not.toThrow();
      expect(resolveServerLocale({ header }, POLYGLOT).resolvedBy, header).toBe("default");
    }
  });

  test("`*` is a range rather than a fault — it means the first language you have", () => {
    const spanishFirst = config({ supportedLocales: ["es", "en"], defaultLocale: "en" });
    const resolved = resolveServerLocale({ header: "*" }, spanishFirst);
    expect(resolved.catalogLocale).toBe("es");
    expect(resolved.resolvedBy).toBe("header");
  });

  test("a broken token beside a good one does not sink the good one", () => {
    const resolved = resolveServerLocale({ header: "en_US, , fr;q=0.7" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("fr");
  });

  test("a malformed param or cookie is skipped, and the header behind it still answers", () => {
    const resolved = resolveServerLocale({ param: "<script>", cookie: "en_US", header: "fr" }, POLYGLOT);
    expect(resolved.catalogLocale).toBe("fr");
    expect(resolved.resolvedBy).toBe("header");
  });
});
