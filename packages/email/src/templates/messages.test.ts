// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LocaleCatalogs } from "@pithy-sh/core/src/i18n/catalog";
import { describe, expect, test } from "vitest";
import { renderEmail, renderSubject } from "./engine";
import { catalogLayers, EMAIL_MESSAGES, emailTranslator, kitEmailLayers } from "./messages";
import { emailFoot, emailHead } from "./partials";
import { templates } from "./registry";
import { defaultTheme, type EmailTheme } from "./theme";

const theme: EmailTheme = { ...defaultTheme, appName: "Acme" };

/**
 * A stand-in second language, written here rather than imported.
 *
 * `@pithy-sh/email` deliberately depends on no i18n capability — the kit's translations ship in
 * `@pithy-sh/i18n` and reach this package as *data*, through `layersFor` — so a test that reached for
 * the real Spanish would be asserting a dependency this package must not have. What is under test is
 * the mechanism: a catalog arrives from outside, and the words in the mail change.
 */
const ES: LocaleCatalogs = {
  es: {
    "email/magic_link.subject": "Tu enlace de acceso",
    "email/magic_link.heading": "Iniciar sesión",
    "email/magic_link.instruction": "usa el botón de abajo para iniciar sesión.",
    "email/magic_link.expiry.one": "Caduca en {count} minuto.",
    "email/magic_link.expiry.other": "Caduca en {count} minutos.",
    "email/shell.greeting_named": "Hola {name}:",
  },
};

const MAGIC_LINK = { url: "https://acme.test/signin?t=abc", expiresMinutes: 15, name: "Sam" };

describe("the words come from the catalog, and the layout does not", () => {
  test("with nothing composed, a message renders in the kit's English exactly as it always did", async () => {
    const result = await renderEmail("magicLink", MAGIC_LINK, theme);

    expect(result.subject).toBe("Your sign-in link");
    expect(result.text).toContain("Use this link to sign in (expires in 15 minutes):");
    expect(result.html).toContain('<html lang="en" dir="ltr"');
  });

  test("a job's locale changes the words in both parts and both render sites", async () => {
    // The two sites are the point. `renderSubject` runs at enqueue, inside a request; `renderEmail`
    // runs at send, inside a Workflow with no request on it. Before the locale was on the row they
    // could agree only by accident, and a Spanish subject over an English body is what that looked like.
    const t = emailTranslator("es", catalogLayers(ES));

    expect(renderSubject("magicLink", MAGIC_LINK, theme, t)).toBe("Tu enlace de acceso");

    const result = await renderEmail("magicLink", MAGIC_LINK, theme, undefined, t);
    expect(result.subject).toBe("Tu enlace de acceso");
    expect(result.html).toContain("Hola Sam:");
    expect(result.html).toContain("usa el botón de abajo para iniciar sesión.");
    expect(result.html).toContain("Caduca en 15 minutos.");
  });

  test("a sentence the catalog does not answer falls back to English rather than to its key", async () => {
    // The half-translated locale, which is the normal state of one. `ES` above has no `magic_link.cta`
    // and no `magic_link.ignore`, and a reader must meet the English for those — not `email/…`, which
    // is what a lookup with no fallback layer would render.
    const result = await renderEmail(
      "magicLink",
      MAGIC_LINK,
      theme,
      undefined,
      emailTranslator("es", catalogLayers(ES)),
    );

    // The apostrophe arrives HTML-escaped, which is the sentence being escaped on exactly the path a
    // payload value is — the property `t` returning a plain string rather than a `SafeString` buys.
    expect(result.html).toContain("If you didn&#x27;t request this, you can ignore this email.");
    expect(result.html).not.toContain("email/magic_link.ignore");
  });

  test("a regional tag reads the language's catalog and still formats as the region", () => {
    // `es-AR` is a locale nobody wrote a catalog for and `Intl` supports natively. Collapsing the two
    // into one value is the bug where an Argentine either reads English or reads Spanish with US
    // number formatting; keeping them apart is why `Translator` carries both.
    const t = emailTranslator("es-AR", catalogLayers(ES));

    expect(t.t("email/magic_link.subject")).toBe("Tu enlace de acceso");
    expect(t.formattingLocale).toBe("es-AR");
    expect(t.formatNumber(1234.5)).toBe("1.234,5");
  });

  test("the shell declares the document's language and direction, and an RTL locale lays out right-to-left", async () => {
    // There was no `dir` in this shell at all before pithy-sh/pithy#441, so an Arabic body inherited a
    // left-to-right document and every client laid it out backwards.
    const result = await renderEmail("magicLink", MAGIC_LINK, theme, undefined, emailTranslator("ar", kitEmailLayers));

    expect(result.html).toContain('<html lang="ar" dir="rtl"');
    expect(result.html).toContain('aria-roledescription="email" lang="ar" dir="rtl"');
  });
});

describe("a catalog value is escaped exactly where a payload value is", () => {
  /**
   * The security constraint the catalog introduced, pinned.
   *
   * `subject` and `text` are precompiled with `noEscape`, so anything substituted there is verbatim —
   * correct, because neither is an HTML context, and the reason no catalog value in this kit carries
   * markup. The HTML body is the one that escapes, and it has to keep escaping: the helpers return
   * plain strings and never a `SafeString`, which is what makes an overridden sentence no more
   * privileged than a payload field.
   */
  const ATTACK: LocaleCatalogs = {
    xx: {
      "email/magic_link.heading": '<img src=x onerror="alert(1)">',
      "email/magic_link.subject": "<b>Sign in</b>",
    },
  };

  test("markup in a catalog message renders as visible text in the HTML body", async () => {
    const result = await renderEmail(
      "magicLink",
      MAGIC_LINK,
      theme,
      undefined,
      emailTranslator("xx", catalogLayers(ATTACK)),
    );

    expect(result.html).not.toMatch(/onerror=/i);
    expect(result.html).not.toMatch(/<img src=x/i);
    expect(result.html).toContain("&lt;img");
  });

  test("and passes through the subject line untouched, which is why nothing here may carry markup", async () => {
    const result = await renderEmail(
      "magicLink",
      MAGIC_LINK,
      theme,
      undefined,
      emailTranslator("xx", catalogLayers(ATTACK)),
    );

    expect(result.subject).toBe("<b>Sign in</b>");
  });
});

describe("every key a template asks for is a key this package writes", () => {
  /** Every `{{t "…"}}` and `{{tn "…"}}` key in a Handlebars source. */
  function catalogKeys(source: string): { plain: string[]; plural: string[] } {
    const plain: string[] = [];
    const plural: string[] = [];
    for (const match of source.matchAll(/\{\{(t|tn)\s+"([^"]+)"/g)) {
      const key = match[2];
      if (!key) continue;
      (match[1] === "tn" ? plural : plain).push(key);
    }
    return { plain, plural };
  }

  test("no template renders its own key, which is what a typo would look like in somebody's inbox", () => {
    // A missing key is not a crash. `t` returns the key itself — the honest answer for an adopter's own
    // domain — so a mistyped kit key ships as `email/magic_link.headng` in a sign-in email and nothing
    // anywhere fails. This is the check that makes it fail here instead.
    const english = EMAIL_MESSAGES.en ?? {};
    const missing: string[] = [];
    const sources = [
      ...Object.values(templates).flatMap((def) => [def.subject, def.html, def.text]),
      emailHead,
      emailFoot,
    ];
    for (const source of sources) {
      const { plain, plural } = catalogKeys(source);
      for (const key of plain) if (english[key] === undefined) missing.push(key);
      // A plural key is two entries. `other` is the fallback the translator lands on for any category
      // a locale did not spell, so it is the one that must exist; `one` is what English needs.
      for (const key of plural) {
        for (const form of ["one", "other"]) {
          if (english[`${key}.${form}`] === undefined) missing.push(`${key}.${form}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the severity vocabulary is in the catalog too, all three levels", () => {
    // `severityLabel` resolves `email/severity.<level>` through the translator now. The three words are
    // what an operational notice says out loud in a subject line, and a level whose word went missing
    // would render `email/severity.warning` there.
    const english = EMAIL_MESSAGES.en ?? {};
    for (const level of ["info", "warning", "critical"]) {
      expect(english[`email/severity.${level}`], `email/severity.${level}`).toBeTruthy();
    }
  });

  test("every key this package writes is under its own domain", () => {
    // `composeMessages` refuses anything else at assembly, and refusing there means a worker that will
    // not start. Same rule as `pithy_email_*` and `email/*` error codes; this is the cheap place to
    // catch a stray one.
    const stray = Object.keys(EMAIL_MESSAGES.en ?? {}).filter((key) => !key.startsWith("email/"));
    expect(stray).toEqual([]);
  });
});
