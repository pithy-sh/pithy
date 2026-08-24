// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { matchLocale } from "@pithy-sh/core/src/i18n/match";
import { describe, expect, test } from "vitest";
import { BrowserResolver, I18nConfig, ServerResolver } from "./config";

/**
 * The config is the one Zod object in this package, and it is the one an adopter writes by hand — so
 * it is the one whose refusals have to say something. Every case below asserts the *message*, not just
 * that a parse failed: a config that refuses without naming why sends whoever wrote it to read our
 * source, and the whole point of `.check()` here rather than a runtime guard is that they never have to.
 */

/** The first issue at `path`, or `undefined`. Issues are compared by path because order is not a contract. */
function issueAt(result: ReturnType<typeof I18nConfig.safeParse>, path: readonly (string | number)[]) {
  return result.success ? undefined : result.error.issues.find((issue) => issue.path.join(".") === path.join("."));
}

describe("I18nConfig defaults", () => {
  test("an unconfigured project is monolingual English, and every knob has a value", () => {
    // The zero-config shape matters beyond tidiness: `i18n()` with no argument is what `pithy add i18n`
    // writes, and the middleware reads every one of these fields on every request. A default that
    // arrived as `undefined` would be a per-request crash rather than a config mistake.
    expect(I18nConfig.parse({})).toEqual({
      supportedLocales: ["en"],
      defaultLocale: "en",
      messages: {},
      exceptions: {},
      cookie: "pithy_locale",
      queryParam: "lang",
      storageKey: "pithy.locale",
      serverResolvers: ["param", "user", "cookie", "header", "default"],
      browserResolvers: ["query", "account", "storage", "navigator", "server", "default"],
    });
  });

  test("the two chain defaults are the orders `docs/I18N.md` documents", () => {
    const parsed = I18nConfig.parse({});
    // Stated as literals rather than compared against the module's own constants: a test that reads
    // the constant agrees with whatever the constant last became, which is the one thing a documented
    // order must not do.
    expect(parsed.serverResolvers).toEqual(["param", "user", "cookie", "header", "default"]);
    expect(parsed.browserResolvers).toEqual(["query", "account", "storage", "navigator", "server", "default"]);
  });
});

describe("I18nConfig refusals", () => {
  test("a `defaultLocale` outside `supportedLocales` is refused, and the message says what breaks", () => {
    const result = I18nConfig.safeParse({ supportedLocales: ["en", "fr"], defaultLocale: "es" });
    expect(result.success).toBe(false);
    const issue = issueAt(result, ["defaultLocale"]);
    expect(issue?.message).toContain("`es`");
    expect(issue?.message).toContain("supportedLocales");
    // The consequence, not just the rule. A default nothing serves means the last link of both chains
    // answers with a locale that has no catalog and no `Intl` promise behind it.
    expect(issue?.message).toContain("nothing would answer");
  });

  test("a default that *is* supported parses, so the check is not refusing everything", () => {
    expect(I18nConfig.parse({ supportedLocales: ["en", "es"], defaultLocale: "es" }).defaultLocale).toBe("es");
  });

  test("`messages` under a locale the project does not serve is refused, naming the locale", () => {
    const result = I18nConfig.safeParse({
      supportedLocales: ["en"],
      messages: { es: { "app/greeting": "Hola." } },
    });
    expect(result.success).toBe(false);
    const issue = issueAt(result, ["messages", "es"]);
    expect(issue?.message).toContain("`es`");
    expect(issue?.message).toContain("nothing would ever read them");
  });

  test("the same catalog under a supported locale parses", () => {
    const parsed = I18nConfig.parse({
      supportedLocales: ["en", "es"],
      messages: { es: { "app/greeting": "Hola." } },
    });
    expect(parsed.messages.es?.["app/greeting"]).toBe("Hola.");
  });

  test("a malformed locale tag is refused before `Intl` ever sees it", () => {
    // `en_US` is the underscore spelling that appears in real `Accept-Language` headers and in
    // hand-written config; `new Intl.Locale("en_US")` throws a `RangeError`. Refusing it at parse is
    // what keeps the throw out of the request path.
    for (const tag of ["en_US", "*", "e", "en-", "en US"]) {
      expect(I18nConfig.safeParse({ supportedLocales: [tag], defaultLocale: tag }).success, tag).toBe(false);
    }
    // And the shapes that are real tags still parse, region and script included.
    for (const tag of ["en", "es-AR", "zh-Hant-TW"]) {
      expect(I18nConfig.parse({ supportedLocales: [tag], defaultLocale: tag }).defaultLocale, tag).toBe(tag);
    }
  });

  test("an empty `supportedLocales` is refused — a project serves at least one language", () => {
    expect(I18nConfig.safeParse({ supportedLocales: [] }).success).toBe(false);
  });

  test("an empty chain is refused, on both sides", () => {
    expect(I18nConfig.safeParse({ serverResolvers: [] }).success).toBe(false);
    expect(I18nConfig.safeParse({ browserResolvers: [] }).success).toBe(false);
  });
});

describe("the resolver vocabularies", () => {
  test("every `ServerResolver` arm is a link a project may declare", () => {
    expect(ServerResolver.options).toEqual(["param", "user", "cookie", "header", "default"]);
    for (const arm of ServerResolver.options) {
      expect(I18nConfig.parse({ serverResolvers: [arm] }).serverResolvers, arm).toEqual([arm]);
    }
  });

  test("every `BrowserResolver` arm is a link a project may declare", () => {
    expect(BrowserResolver.options).toEqual(["query", "account", "storage", "navigator", "server", "default"]);
    for (const arm of BrowserResolver.options) {
      expect(I18nConfig.parse({ browserResolvers: [arm] }).browserResolvers, arm).toEqual([arm]);
    }
  });

  test("the two vocabularies are not interchangeable", () => {
    // `storage` is a browser link and `cookie` is a server one. They are two enums rather than one
    // because half the links do not exist on the other side; accepting each other's arms would make
    // that split cosmetic.
    expect(I18nConfig.safeParse({ serverResolvers: ["storage"] }).success).toBe(false);
    expect(I18nConfig.safeParse({ browserResolvers: ["cookie"] }).success).toBe(false);
  });
});

describe("an exception is honored however it is spelled", () => {
  test("a BCP-47 cased key still matches, because the lookup lower-cases the range", () => {
    // `matchLocale` compares against a lower-cased range, so an exception written the way anybody
    // would write it — `nb-NO`, the exact pair this field's own doc names — was silently dead: the
    // reader fell through to the project default and nothing said so.
    const resolved = I18nConfig.parse({ supportedLocales: ["en", "no"], exceptions: { "nb-NO": "no" } });
    expect(resolved.exceptions).toEqual({ "nb-no": "no" });
    expect(matchLocale(["nb-NO"], resolved.supportedLocales, resolved.exceptions)?.locale).toBe("no");
  });

  test("a lower-cased key is unchanged, so nothing that worked stops working", () => {
    const resolved = I18nConfig.parse({ supportedLocales: ["en", "no"], exceptions: { nb: "no" } });
    expect(matchLocale(["nb"], resolved.supportedLocales, resolved.exceptions)?.locale).toBe("no");
  });
});
