// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The longest language tag this kit accepts. RFC 5646's own grammar allows far more, but a tag that
 * long is not a locale anyone serves — it is a header a caller filled with something else. The bound
 * exists so a hostile `Accept-Language` cannot make the matcher walk a megabyte per request.
 */
export const MAX_LOCALE_TAG_LENGTH = 64;

/**
 * The shape of a well-formed language tag, checked before `Intl.Locale` ever sees it.
 *
 * Deliberately looser than RFC 5646 and deliberately stricter than "any string". Looser, because the
 * authority on whether `es-419` or `zh-Hans-CN` is meaningful is ICU, not a regular expression we would
 * have to keep in step with it. Stricter, because {@link https://tc39.es/ecma402 `Intl.Locale`} throws a
 * `RangeError` rather than returning a signal, and the four things it throws on — `*`, `en_US`, the empty
 * string, and a token still carrying `;q=0.9` — all appear in real `Accept-Language` headers.
 */
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * A BCP-47 language tag — the identity of a locale everywhere in the kit.
 *
 * One string, two jobs, and only one of them falls back: the tag that picks a **catalog** is the words
 * we have written, and the tag that drives **formatting** is whatever the reader asked for. See
 * {@link LocaleContext} for why collapsing them is the bug where an Argentine reads Spanish and sees
 * `1,234.56`.
 */
export const Locale = z
  .string()
  .min(2)
  .max(MAX_LOCALE_TAG_LENGTH)
  .regex(LANGUAGE_TAG, { message: "A locale is a BCP-47 tag like `en`, `es`, or `es-AR`." })
  // **And then ICU has to accept it**, which is a strictly narrower thing than matching the shape.
  // `en-x`, `en-t`, `en-u`, `en-1` and `en-a-bbb-a-ccc` are all well-formed by the grammar above and
  // all raise `RangeError` in `new Intl.Locale()`: a singleton subtag with nothing after it, and a
  // repeated extension, are shapes the pattern cannot see.
  //
  // The check is here rather than at each render site because of where the values end up. This schema
  // guards `pithy_auth_users.locale` and `pithy_email_jobs.locale`, so a tag it admits is a tag stored
  // in D1 — and the place it is read back is `renderEmail`, inside the send Workflow, with no request
  // on it. An `Intl` construction that throws there is a raw `RangeError` rather than a `PithyError`,
  // `classifySendError` sees no code it knows, and the job burns its retries and wedges. Refusing the
  // value on the way in costs one `try` at a boundary that was already validating; catching it on the
  // way out costs a guard at every site that ever formats, forever, and one of them will be forgotten.
  .refine((tag) => parseLocale(tag) !== null, {
    message: "That is not a language tag `Intl` accepts. `en-x` and `en-a-bbb-a-ccc` are the usual shapes that miss.",
  })
  .describe("A BCP-47 language tag (`en`, `es`, `es-AR`) — the identity of a locale across the kit.");
export type Locale = z.infer<typeof Locale>;

/** Which way a locale's script runs. Drives the `dir` attribute on the document and the email shell. */
export const TextDirection = z
  .enum(["ltr", "rtl"])
  .describe("Which way a locale's script runs — the value of the `dir` attribute.");
export type TextDirection = z.infer<typeof TextDirection>;

/**
 * The per-request locale seam, published on `c.var.locale` by `@pithy-sh/i18n` and `null` in a Worker
 * that does not compose it. Core defines the shape; one capability populates it — the same split
 * `AuthContext` uses, and for the same reason: `@pithy-sh/email` and the error module both need a
 * locale and neither may import an i18n capability.
 */
export const LocaleContext = z
  .object({
    catalogLocale: Locale.describe("The locale whose catalog answers `t()` — the words the kit actually has."),
    formattingLocale: Locale.describe("The locale handed to `Intl` — what the reader asked for, region and all."),
    direction: TextDirection.describe("The catalog locale's text direction, for `lang`/`dir` on the document."),
  })
  .describe("Per-request resolved locale; the seam capabilities read instead of negotiating their own.");
export type LocaleContext = z.infer<typeof LocaleContext>;

/**
 * `tag` as an `Intl.Locale`, or `null` when it is not one.
 *
 * **Every construction on header- or adopter-supplied input goes through this.** `new Intl.Locale()`
 * throws `RangeError` on `*`, on `en_US`, on the empty string, and on any token still carrying
 * `;q=0.9` — so a malformed `Accept-Language` is an uncaught 500 rather than a fallback, unless the
 * throw is caught somewhere. It is caught here, once, and nowhere else.
 */
export function parseLocale(tag: string): Intl.Locale | null {
  if (!LANGUAGE_TAG.test(tag) || tag.length > MAX_LOCALE_TAG_LENGTH) return null;
  try {
    return new Intl.Locale(tag);
  } catch {
    return null;
  }
}

/**
 * The part of `tag` that may be handed to `Intl` as a **formatting** locale, or `null` when it is not a
 * tag at all: language, script, region and variants, with every extension subtag stripped.
 *
 * **A `-u-` extension is not a locale, it is an instruction**, and the range a formatting locale is
 * built from is caller-supplied. `?lang=en-u-nu-hanidec` truncates to `en`, matches a project that
 * ships English, and — kept whole — reaches `Intl.NumberFormat` verbatim, where it renders `1,234` as
 * `一,二三四`. `-u-ca-islamic` does the same to every date on the page. Nothing is disclosed and nothing
 * persists, so it is spoofing rather than a breach; it is also a link somebody can send, and the whole
 * point of resolving against `supportedLocales` is that a reader cannot pick a rendering the project
 * did not offer.
 *
 * `baseName` is exactly the right cut, and is why this is a helper rather than a regex: `es-AR`,
 * `zh-Hant-TW`, `es-419` and `de-DE-1996` all survive whole, because none of them is an extension.
 */
export function formattingLocaleOf(tag: string): string | null {
  return parseLocale(tag)?.baseName ?? null;
}

/** Whether `tag` is a language tag `Intl` will accept — the predicate half of {@link parseLocale}. */
export function isLocale(tag: string): tag is Locale {
  return parseLocale(tag) !== null;
}

/**
 * The languages written right-to-left, for the runtimes that expose neither text-info accessor.
 *
 * A last resort, not the answer: `getTextInfo()` knows about scripts this list cannot name, and it is
 * asked first. The five here are the ones a fallback has to get right.
 */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(["ar", "he", "fa", "ur", "ps"]);

/**
 * Text info as either of the two names the runtimes Pithy targets expose it under.
 *
 * Neither is on the standard's own `Intl.Locale` type in every TypeScript lib, and the split is real:
 * **workerd and Bun expose `getTextInfo()` only; Node 22 — the declared floor, so the CLI — exposes
 * `textInfo` only; Node 24 has both.** Firefox has the method from 153 and Safari the accessor from
 * 15.4. A helper written against either name alone is wrong on roughly half the matrix.
 */
type LocaleWithTextInfo = Intl.Locale & {
  getTextInfo?: () => { direction?: string };
  textInfo?: { direction?: string };
};

/**
 * Which way `tag`'s script runs, feature-detected across both spellings and falling back to a small
 * right-to-left language set when a runtime exposes neither.
 *
 * Total: an unparseable tag is `ltr`, because a document still needs a `dir` and guessing the other way
 * mirrors a page nobody asked to mirror.
 */
export function localeDirection(tag: string): TextDirection {
  const locale = parseLocale(tag);
  if (!locale) return "ltr";
  const withTextInfo = locale as LocaleWithTextInfo;
  const info = typeof withTextInfo.getTextInfo === "function" ? withTextInfo.getTextInfo() : withTextInfo.textInfo;
  if (info?.direction === "rtl") return "rtl";
  if (info?.direction === "ltr") return "ltr";
  return RTL_LANGUAGES.has(locale.language) ? "rtl" : "ltr";
}
