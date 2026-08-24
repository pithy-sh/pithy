// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { formattingLocaleOf, isLocale, Locale, LocaleContext, localeDirection, parseLocale } from "./locale";

describe("Locale", () => {
  test("accepts the tags the kit ships and the regions it formats for", () => {
    for (const tag of ["en", "es", "es-AR", "zh-Hant-TW", "en-GB"]) {
      expect(Locale.safeParse(tag).success, tag).toBe(true);
    }
  });

  test("refuses the four strings a real Accept-Language header carries that Intl throws on", () => {
    // Every one of these appears in a live header, and `new Intl.Locale()` raises a RangeError on each.
    for (const tag of ["*", "en_US", "", "es-ES;q=0.9"]) {
      expect(Locale.safeParse(tag).success, tag).toBe(false);
    }
  });

  test("refuses a tag that is well-formed by the pattern and still throws in ICU", () => {
    // The gap the pattern cannot see: a singleton subtag with nothing after it, and a repeated
    // extension. All five match the grammar and all five raise `RangeError` in `new Intl.Locale()`.
    //
    // This schema guards `pithy_auth_users.locale` and `pithy_email_jobs.locale`, so a tag it admitted
    // would be a tag stored in D1 and read back inside the send Workflow, where an `Intl` throw is a
    // raw `RangeError` with no code `classifySendError` knows — the job burns its retries and wedges.
    for (const tag of ["en-x", "en-t", "en-u", "en-1", "en-US-x", "en-a-bbb-a-ccc"]) {
      expect(Locale.safeParse(tag).success, tag).toBe(false);
    }
  });

  test("still accepts every tag ICU does, including the ones that look unusual", () => {
    for (const tag of ["es-419", "zh-Hant-TW", "en-GB", "en-US-u-ca-gregory", "de-DE-1996"]) {
      expect(Locale.safeParse(tag).success, tag).toBe(true);
    }
  });
});

describe("parseLocale", () => {
  test("returns null rather than throwing on what Intl refuses", () => {
    for (const tag of ["*", "en_US", "", "es-ES;q=0.9", "e", "toolongsubtaghere"]) {
      expect(parseLocale(tag), tag).toBeNull();
    }
  });

  test("parses a tag Intl accepts, and maximizes it", () => {
    expect(parseLocale("es")?.maximize().toString()).toBe("es-Latn-ES");
    expect(parseLocale("zh-TW")?.maximize().toString()).toBe("zh-Hant-TW");
  });

  test("isLocale is the predicate half, and agrees with the schema", () => {
    expect(isLocale("es-AR")).toBe(true);
    expect(isLocale("en_US")).toBe(false);
  });
});

describe("formattingLocaleOf", () => {
  test("strips extension subtags, which are instructions rather than a locale", () => {
    // A `-u-` extension steers `Intl` itself. `?lang=` is caller-supplied and reaches the formatting
    // locale, so kept whole this renders 1,234 as 一,二三四 on a pricing screen — a rendering the
    // project never offered, reachable through a link somebody can send.
    expect(formattingLocaleOf("en-u-nu-hanidec")).toBe("en");
    expect(formattingLocaleOf("en-u-ca-islamic")).toBe("en");
    expect(formattingLocaleOf("es-AR-u-nu-thai")).toBe("es-AR");
  });

  test("keeps everything that is genuinely part of the locale", () => {
    expect(formattingLocaleOf("es-ar")).toBe("es-AR");
    expect(formattingLocaleOf("zh-Hant-TW")).toBe("zh-Hant-TW");
    expect(formattingLocaleOf("es-419")).toBe("es-419");
    expect(formattingLocaleOf("de-DE-1996")).toBe("de-DE-1996");
  });

  test("a stripped tag formats as the project meant it to", () => {
    const steered = formattingLocaleOf("en-u-nu-hanidec") as string;
    expect(new Intl.NumberFormat(steered).format(1234)).toBe("1,234");
  });

  test("is null for anything that is not a tag, so a caller falls back rather than throwing", () => {
    for (const tag of ["*", "en_US", "", "en-x"]) {
      expect(formattingLocaleOf(tag), tag).toBeNull();
    }
  });
});

describe("localeDirection", () => {
  test("reads direction through whichever text-info name this runtime exposes", () => {
    // workerd and Bun expose `getTextInfo()`; Node 22 exposes `textInfo`; Node 24 has both. A helper
    // written against one name alone is wrong on half the matrix, so both spellings are tried.
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("he")).toBe("rtl");
    expect(localeDirection("en")).toBe("ltr");
    expect(localeDirection("es")).toBe("ltr");
  });

  test("is total — an unparseable tag still yields a direction a document can use", () => {
    expect(localeDirection("en_US")).toBe("ltr");
    expect(localeDirection("*")).toBe("ltr");
  });
});

describe("LocaleContext", () => {
  test("carries both locales, because only one of them falls back", () => {
    const context = LocaleContext.parse({ catalogLocale: "es", formattingLocale: "es-AR", direction: "ltr" });
    expect(context.catalogLocale).toBe("es");
    expect(context.formattingLocale).toBe("es-AR");
  });
});
