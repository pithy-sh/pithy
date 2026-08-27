// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { fromI18next, fromIntl, fromLingui, type I18nextLike, type IntlShapeLike, type LinguiLike } from "./adapters";

/**
 * The three adapters, each against a hand-written fake of the shape it duck-types.
 *
 * **Hand-written rather than the real library, and that is the point rather than a shortcut.** None of
 * i18next, FormatJS or Lingui is a dependency of this package and none can become one — an adapter that
 * imported the library would make an optional bridge a mandatory install for every adopter of the kit.
 * What each adapter names is a structural type of three or four members, so a fake with those members
 * *is* the contract, and a case here fails exactly when the adapter starts calling something else.
 */

/** One call the fake recorded: what was asked for, and what was handed alongside. */
interface Call {
  /** The key or message id the adapter asked the library for. */
  readonly key: string;
  /** The second argument — i18next's options, FormatJS's and Lingui's values. */
  readonly second: Record<string, unknown> | undefined;
}

/** An i18next instance, as much of one as `fromI18next` touches. */
function i18nextFake(language = "es") {
  const calls: Call[] = [];
  const instance: I18nextLike = {
    language,
    t: (key, options) => {
      calls.push({ key, second: options });
      return `i18next:${key}`;
    },
  };
  return { instance, calls };
}

/** A FormatJS `IntlShape`, as much of one as `fromIntl` touches. */
function intlFake(locale = "es") {
  const calls: Call[] = [];
  const instance: IntlShapeLike = {
    locale,
    formatMessage: (descriptor, values) => {
      calls.push({ key: descriptor.id, second: values });
      return `intl:${descriptor.id}`;
    },
  };
  return { instance, calls };
}

/** A Lingui `I18n`, as much of one as `fromLingui` touches. */
function linguiFake(locale = "es") {
  const calls: Call[] = [];
  const instance: LinguiLike = {
    locale,
    _: (id, values) => {
      calls.push({ key: id, second: values });
      return `lingui:${id}`;
    },
  };
  return { instance, calls };
}

describe("the words come from the wrapped library", () => {
  test("`t` delegates, and carries the params through", () => {
    const i18next = i18nextFake();
    const intl = intlFake();
    const lingui = linguiFake();
    expect(fromI18next(i18next.instance).t("app/greeting", { name: "Ada" })).toBe("i18next:app/greeting");
    expect(fromIntl(intl.instance).t("app/greeting", { name: "Ada" })).toBe("intl:app/greeting");
    expect(fromLingui(lingui.instance).t("app/greeting", { name: "Ada" })).toBe("lingui:app/greeting");
    for (const { calls } of [i18next, intl, lingui]) {
      expect(calls).toEqual([{ key: "app/greeting", second: { name: "Ada" } }]);
    }
  });

  test("the catalog locale is the library's own active language", () => {
    expect(fromI18next(i18nextFake("fr").instance).catalogLocale).toBe("fr");
    expect(fromIntl(intlFake("fr").instance).catalogLocale).toBe("fr");
    expect(fromLingui(linguiFake("fr").instance).catalogLocale).toBe("fr");
  });

  test("the direction is derived from that locale, not asked of the library", () => {
    // The libraries do not all answer this, and the ones that do disagree. `Intl` does not.
    expect(fromI18next(i18nextFake("ar").instance).direction).toBe("rtl");
    expect(fromIntl(intlFake("he").instance).direction).toBe("rtl");
    expect(fromLingui(linguiFake("en").instance).direction).toBe("ltr");
  });
});

describe("the formatting never is", () => {
  test("numbers, currency, dates and lists all come from `Intl`", () => {
    // Every one of these libraries formats through `Intl` anyway, workerd embeds full ICU, and a
    // `Translator` that formatted through a wrapper would answer a different date for the same locale
    // depending on which adapter happened to be in use. So the formatting half is never delegated.
    const { instance, calls } = i18nextFake();
    const t = fromI18next(instance);
    expect(t.formatNumber(1234.56)).toBe("1234,56");
    expect(t.formatCurrency(9.5, "EUR")).toContain("9,50");
    expect(t.formatList(["a", "b", "c"])).toBe("a, b y c");
    expect(t.formatRelativeTime(-1, "day")).toBe("hace 1 día");
    // The date the test's own name promised and nothing asserted until #441. `timeZone` is stated
    // because the machine's is not the reader's, and a date that formats differently in two offices
    // is the flake this file would otherwise have been one commit away from.
    expect(t.formatDate(Date.UTC(2026, 7, 23), { timeZone: "UTC" })).toBe("23/8/2026");
    expect(t.formatDate(new Date(Date.UTC(2026, 7, 23)), { timeZone: "UTC", dateStyle: "long" })).toBe(
      "23 de agosto de 2026",
    );
    // The proof that none of it went through the library: the fake was never asked anything.
    expect(calls).toEqual([]);
  });

  test("English through a Spanish-catalog adapter formats in English", () => {
    // `formattingLocale` is the adapter's second argument and it overrides the library's language.
    // An adopter whose i18next is loaded with `es` but whose reader asked for `en-US` gets both.
    const t = fromI18next(i18nextFake("es").instance, "en-US");
    expect(t.catalogLocale).toBe("es");
    expect(t.formattingLocale).toBe("en-US");
    expect(t.formatNumber(1234.56)).toBe("1,234.56");
    expect(t.formatList(["a", "b", "c"])).toBe("a, b, and c");
  });

  test("with no override, formatting follows the library's language", () => {
    expect(fromIntl(intlFake("en").instance).formatNumber(1234.56)).toBe("1,234.56");
    expect(fromLingui(linguiFake("es").instance).formatNumber(1234.56)).toBe("1234,56");
  });
});

describe("plurals stay the wrapped library's business", () => {
  test("`fromI18next` hands `count` to i18next as an option and lets it select", () => {
    // i18next selects from a `count` option rather than from a key suffix, so the kit's
    // `<key>.<category>` convention is not imposed on a catalog i18next already owns. **The key asked
    // for is the bare key** — an adapter that appended `.other` would ask i18next for a key its own
    // catalog does not have.
    const { instance, calls } = i18nextFake();
    fromI18next(instance).plural("app/items", 3, { name: "Ada" });
    expect(calls).toEqual([{ key: "app/items", second: { count: 3, name: "Ada" } }]);
  });

  test("`fromIntl` hands `count` to FormatJS as a value, for the message's own plural arm", () => {
    // FormatJS resolves plurals inside the ICU message, so `count` arrives in `formatMessage`'s
    // *values* — the argument the `{count, plural, …}` arm reads — beside a descriptor holding the
    // bare id.
    const { instance, calls } = intlFake();
    fromIntl(instance).plural("app/items", 3, { name: "Ada" });
    expect(calls).toEqual([{ key: "app/items", second: { count: 3, name: "Ada" } }]);
  });

  test("`fromLingui` does the same, through `_`", () => {
    const { instance, calls } = linguiFake();
    fromLingui(instance).plural("app/items", 3);
    expect(calls).toEqual([{ key: "app/items", second: { count: 3 } }]);
  });

  test("a caller's own `count` wins over the one the adapter supplies", () => {
    // The spread order is `{ count, ...params }`, so an explicit parameter is not silently overwritten.
    const { instance, calls } = i18nextFake();
    fromI18next(instance).plural("app/items", 3, { count: 7 });
    expect(calls[0]?.second).toEqual({ count: 7 });
  });

  test("no adapter asks for a `<key>.<category>` key, at any count", () => {
    // The one thing all three must not do. The kit's suffix convention belongs to the kit's own
    // catalogs; a wrapped library owns its keys, and asking it for `app/items.one` finds nothing —
    // an adapter that imposed the convention would render bare keys at every reader of every count.
    const i18next = i18nextFake();
    const intl = intlFake();
    const lingui = linguiFake();
    for (const count of [0, 1, 2, 11]) {
      fromI18next(i18next.instance).plural("app/items", count);
      fromIntl(intl.instance).plural("app/items", count);
      fromLingui(lingui.instance).plural("app/items", count);
    }
    for (const { calls } of [i18next, intl, lingui]) {
      expect(calls.map((call) => call.key)).toEqual(["app/items", "app/items", "app/items", "app/items"]);
    }
  });
});

describe("the shapes the adapters document are the shapes they accept", () => {
  /**
   * **The documented examples, compiled.** Each adapter's whole promise is that the instance an adopter
   * already has satisfies its structural type with nothing installed — so the thing worth asserting is
   * that a minimal stand-in for each library type-checks and answers, not that a mock we wrote does.
   *
   * The prose lives at pithy.sh/docs/build/language-and-locale/bring-your-own-stack. It named this
   * package's README until #459, and a test that cites a document by name is a test whose premise the
   * next edit to that document can quietly falsify — so what is asserted here is the adapters, not the
   * agreement between the adapters and a file.
   *
   * These are deliberately the members the real libraries expose: i18next's `language` + `t(key,
   * options)`, FormatJS's `locale` + `formatMessage({ id }, values)`, Lingui's `locale` + `_(id,
   * values)`.
   */
  test("`maybe` answers null on a miss, which is what the error contract rests on", () => {
    // The bug this pins: `wrap` built its base from `createTranslator` with no layers, so an inherited
    // `maybe` answered `null` for everything — and every adapted translator silently rendered the
    // English fallback for every code it could in fact translate.
    const t = fromI18next({ language: "es", t: (key) => (key === "auth/invalid_token" ? "Sesión no válida." : key) });
    expect(t.maybe("auth/invalid_token")).toBe("Sesión no válida.");
    expect(t.maybe("auth/nothing_here")).toBeNull();
    // Which is the whole point: the documented contract now falls back for real.
    expect(t.maybe("auth/nothing_here") ?? "The session is not valid.").toBe("The session is not valid.");
    expect(t.maybe("auth/invalid_token") ?? "The session is not valid.").toBe("Sesión no válida.");
  });

  test("each adapter reads the locale off the member its own library exposes", () => {
    expect(fromI18next({ language: "es", t: (k) => k }).catalogLocale).toBe("es");
    expect(fromIntl({ locale: "fr", formatMessage: (d) => d.id }).catalogLocale).toBe("fr");
    expect(fromLingui({ locale: "de", _: (id) => id }).catalogLocale).toBe("de");
  });

  test("the formatting locale is the second argument, and only that", () => {
    const t = fromI18next({ language: "es", t: (k) => k }, "es-AR");
    expect(t.catalogLocale).toBe("es");
    expect(t.formattingLocale).toBe("es-AR");
    expect(t.formatNumber(1234.5)).toBe("1.234,5");
  });
});
