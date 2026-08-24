// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { fromI18next } from "../adapters/adapters";
import { TranslatorProvider, type TranslatorSource, useTranslator } from "./translator";

/**
 * The React bindings, rendered.
 *
 * **Rendered rather than called**, because `useTranslator` is a hook and its whole contract is about
 * context: what it does with a provider, what it does without one, and where a screen's own baked
 * English sits in the walk. None of that is reachable by calling the function.
 *
 * `react-dom/server`'s `renderToStaticMarkup` is the renderer, and it is the smallest thing in the
 * workspace that works: no `act`, no root, no `IS_REACT_ACT_ENVIRONMENT`, and nothing here is
 * interactive — every case is a first paint. `@testing-library/react` is not a dependency of this
 * package and none is added for this.
 */

/** The English a scaffolded screen carries with it. The only catalog that survives being copied. */
const BAKED_EN: MessageCatalog = {
  "app/greeting": "Hello.",
  "app/kit_only": "The kit wrote this one.",
  "app/baked_only": "Only the screen has this.",
};

/** The kit's Spanish for the same screen — shipped in the package, never copied into a repository. */
const KIT_ES: MessageCatalog = {
  "app/greeting": "Hola.",
  "app/kit_only": "Esto lo escribio el kit.",
};

/** One sentence the adopter overrode. Everything they did not mention keeps flowing from the package. */
const ADOPTER_ES: MessageCatalog = { "app/greeting": "Buenas." };

/** Every key the probe renders, including one nobody anywhere has written. */
const KEYS = ["app/greeting", "app/kit_only", "app/baked_only", "app/nobody_has_this"] as const;

/** A screen: it takes the English it was scaffolded with and renders through whatever it is given. */
function Probe({ fallback }: { fallback?: MessageCatalog }) {
  const t = useTranslator(fallback);
  return (
    <ul>
      {KEYS.map((key) => (
        <li key={key} data-message={key}>
          {t.t(key)}
        </li>
      ))}
      <li data-message="@locales">{`${t.catalogLocale}|${t.formattingLocale}|${t.direction}`}</li>
      <li data-message="@number">{t.formatNumber(1234.56)}</li>
      <li data-message="@plural">{t.plural("app/items", 2)}</li>
    </ul>
  );
}

/** What one render said, keyed by the message key it answered. */
function rendered(markup: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, key, text] of markup.matchAll(/<li data-message="([^"]+)">([^<]*)<\/li>/g)) {
    if (key !== undefined) found[key] = text ?? "";
  }
  return found;
}

/** A Spanish provider over the adopter's catalog and the kit's, formatting as `es-AR`. */
const SPANISH: TranslatorSource = {
  catalogLocale: "es",
  formattingLocale: "es-AR",
  layers: [ADOPTER_ES, KIT_ES],
};

describe("no provider at all", () => {
  const answers = rendered(renderToStaticMarkup(<Probe fallback={BAKED_EN} />));

  test("a copied screen renders its own English, byte for byte", () => {
    // **What a screen does in a project that never composed i18n.** `pithy ui add` copies these files;
    // no command retrofits a provider into a repository that already has them. So the no-provider path
    // is not a degraded mode — it is the majority of installs, and it has to be exactly what shipped.
    expect(answers["app/greeting"]).toBe("Hello.");
    expect(answers["app/baked_only"]).toBe("Only the screen has this.");
  });

  test("it does not throw for want of a provider", () => {
    expect(() => renderToStaticMarkup(<Probe fallback={BAKED_EN} />)).not.toThrow();
  });

  test("no kit layer is reachable — there is no negotiation and no merge", () => {
    // The kit's Spanish is not in this walk at all. Only the baked catalog is, which is what makes a
    // project composing nothing behave as it did before any of this landed.
    expect(answers["app/kit_only"]).toBe("The kit wrote this one.");
    expect(answers["@locales"]).toBe("en|en|ltr");
    expect(answers["@number"]).toBe("1,234.56");
  });

  test("a screen with no baked catalog renders keys rather than blanks", () => {
    const bare = rendered(renderToStaticMarkup(<Probe />));
    expect(bare["app/greeting"]).toBe("app/greeting");
  });
});

describe("with a provider", () => {
  const answers = rendered(
    renderToStaticMarkup(
      <TranslatorProvider value={SPANISH}>
        <Probe fallback={BAKED_EN} />
      </TranslatorProvider>,
    ),
  );

  test("the adopter's layer wins", () => {
    // All three layers have `app/greeting`. The adopter's override is one entry, and it beats both.
    expect(answers["app/greeting"]).toBe("Buenas.");
  });

  test("the kit's layer is next", () => {
    // The adopter never mentioned this key, so it keeps arriving from the package — which is what
    // makes an override a merge rather than a fork.
    expect(answers["app/kit_only"]).toBe("Esto lo escribio el kit.");
  });

  test("the screen's baked English is LAST, and still reachable", () => {
    // Neither Spanish catalog has this key. A screen that shipped a sentence nobody translated still
    // renders that sentence, rather than rendering its key at a reader.
    expect(answers["app/baked_only"]).toBe("Only the screen has this.");
  });

  test("a key nobody has renders as the key", () => {
    // The honest answer. A blank reads like finished copy and would ship.
    expect(answers["app/nobody_has_this"]).toBe("app/nobody_has_this");
  });

  test("both locales come from the provider, and only one of them fell back", () => {
    expect(answers["@locales"]).toBe("es|es-AR|ltr");
    // Spanish words, Argentine digits — from one translator, in one render.
    expect(answers["@number"]).toBe("1.234,56");
  });

  test("a screen that passes no fallback reads the provider's layers alone", () => {
    const withoutBaked = rendered(
      renderToStaticMarkup(
        <TranslatorProvider value={SPANISH}>
          <Probe />
        </TranslatorProvider>,
      ),
    );
    expect(withoutBaked["app/greeting"]).toBe("Buenas.");
    expect(withoutBaked["app/baked_only"]).toBe("app/baked_only");
  });

  test("plural selection runs in the catalog locale, through the same layers", () => {
    const plural = rendered(
      renderToStaticMarkup(
        <TranslatorProvider value={SPANISH}>
          <Probe fallback={{ "app/items.other": "{count} elementos" }} />
        </TranslatorProvider>,
      ),
    );
    expect(plural["@plural"]).toBe("2 elementos");
  });

  test("the direction follows the catalog locale, so an RTL provider mirrors the document", () => {
    const arabic = rendered(
      renderToStaticMarkup(
        <TranslatorProvider value={{ catalogLocale: "ar", formattingLocale: "ar-EG", layers: [] }}>
          <Probe fallback={BAKED_EN} />
        </TranslatorProvider>,
      ),
    );
    expect(arabic["@locales"]).toBe("ar|ar-EG|rtl");
  });
});

describe("a provider given somebody else's translator", () => {
  /**
   * **The route the adapters had no way onto.** `fromI18next` and friends return a `Translator`, and
   * the provider used to take only the pieces — so an adapted stack could be handed to a kit screen as
   * a `t` prop and was invisible to `useTranslator()` in the adopter's own components. Half the tree
   * reading your message layer is not plugging it in.
   */
  const WORDS: Record<string, string> = { "app/greeting": "Hola.", "app/items": "{{count}} cosas" };

  /** An i18next-shaped instance: the three members the adapter duck-types, and nothing installed. */
  const adapted = fromI18next(
    {
      language: "es",
      t: (key, options) => {
        const found = WORDS[key];
        if (found === undefined) return key;
        return found.replace("{{count}}", String((options as { count?: number } | undefined)?.count ?? ""));
      },
    },
    "es-AR",
  );

  test("every component under it reads the adapted translator", () => {
    const seen = rendered(
      renderToStaticMarkup(
        <TranslatorProvider value={adapted}>
          <Probe />
        </TranslatorProvider>,
      ),
    );
    expect(seen["app/greeting"]).toBe("Hola.");
  });

  test("the screen's own English sits behind it, so an untranslated key still renders a sentence", () => {
    const seen = rendered(
      renderToStaticMarkup(
        <TranslatorProvider value={adapted}>
          <Probe fallback={BAKED_EN} />
        </TranslatorProvider>,
      ),
    );
    // The adapted stack answered this one.
    expect(seen["app/greeting"]).toBe("Hola.");
    // It has no word for these, so the English the screen was scaffolded with shows through.
    expect(seen["app/baked_only"]).toBe("Only the screen has this.");
    expect(seen["app/kit_only"]).toBe("The kit wrote this one.");
    // And a key nobody anywhere wrote renders as the key, never as a blank.
    expect(seen["app/nobody_has_this"]).toBe("app/nobody_has_this");
  });

  test("plural selection stays the wrapped library's, because that is what it is for", () => {
    const seen = rendered(
      renderToStaticMarkup(
        <TranslatorProvider value={adapted}>
          <Probe fallback={BAKED_EN} />
        </TranslatorProvider>,
      ),
    );
    expect(seen["@plural"]).toBe("2 cosas");
  });

  test("formatting comes from Intl at the adapted locale, never from the wrapped library", () => {
    const seen = rendered(
      renderToStaticMarkup(
        <TranslatorProvider value={adapted}>
          <Probe />
        </TranslatorProvider>,
      ),
    );
    expect(seen["@locales"]).toBe("es|es-AR|ltr");
    expect(seen["@number"]).toBe("1.234,56");
  });
});
