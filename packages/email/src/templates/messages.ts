// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type LocaleCatalogs, MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { parseLocale } from "@pithy-sh/core/src/i18n/locale";
import { createTranslator, DEFAULT_LOCALE, type Translator } from "@pithy-sh/core/src/i18n/translator";
import { EMAIL_ES } from "./messages.es";

/**
 * The words this capability writes, in the language it writes them in.
 *
 * ## Why the words live here and not in the template source
 *
 * The obvious way to make an email speak a second language is to precompile the template twice. It is
 * also the expensive way, and the expense is not the part that varies. `precompiled.generated.ts` is
 * 132KB for 38 specs, and almost none of that is prose: it is a Gmail-safe table shell, a VML button
 * fallback, an inline color on every cell, and a `prefers-color-scheme` block — markup that is
 * byte-identical in every language and would be duplicated wholesale per locale, into a Worker bundle
 * that has no lazy loading to hide it behind.
 *
 * It also cannot be done without breaking something structural. The engine registers `emailHead` and
 * `emailFoot` **once, by bare name, on one `Handlebars.create()`**, and caches a compiled entry per
 * template **id**. Per-locale sources force one of two changes: locale-qualified partial names
 * (`emailHead:es`), which means every template body has to know its own locale before it can name its
 * own shell, or one engine instance per locale, which multiplies the partial registry and the compiled
 * cache by the locale count for a document shell that never changes. Neither buys anything, because
 * `engine.test.ts` pins the sorted template id list — so a locale variant could never be an id anyway.
 *
 * So the split is: **the layout is the template's, the words are the catalog's.** One precompiled
 * template per id, one partial registry, one engine, and `{{t}}` / `{{tn}}` join them at render. Adding
 * a locale then costs a catalog and nothing else — no rebuild of the specs, no growth in the shipped
 * artifact beyond the sentences themselves.
 *
 * ## Escaping
 *
 * A catalog value reaching the HTML body goes through an ordinary `{{t …}}` mustache, so Handlebars
 * escapes it exactly as it escapes a payload value — the helpers return plain strings and **never** a
 * `SafeString`, which is what keeps that true. `subject` and `text` are precompiled with
 * `noEscape: true`, so a value substituted there is unescaped; that is correct for those parts (a
 * subject line and a plain-text body are not HTML contexts) and it is why nothing in this file, and
 * nothing an adopter overrides it with, may carry markup. Interpolated parameters are escaped with the
 * sentence that carries them, so `{{t "email/welcome.body" name=name}}` escapes `name` exactly as
 * `{{name}}` did.
 *
 * ## Only the kit's own copy
 *
 * Seven templates are here. The five whose words arrive as payload — `testerNudge`, `supportReply`,
 * `operationalNotice`, `newsletter`, `marketingCampaign` — are the adopter's copy, chosen by a human
 * for one message, and a catalog cannot translate a sentence it has never seen. Their **shell** still
 * follows the job's locale (the severity word, the footer, the document's `lang` and `dir`), so a
 * notice at locale `es` reads its severity in Spanish and its summary in whatever the caller wrote.
 */

/** The kit's English for every string the seven kit-authored templates and the shared shell render. */
const EMAIL_EN: MessageCatalog = {
  // --- The shared shell ---
  // The greeting is two keys rather than one with an optional placeholder, because a language that
  // greets an unnamed reader differently — not merely with the name removed — has no way to say so in
  // a single string. English happens to differ only by the name; Spanish already differs by more.
  "email/shell.greeting": "Hi,",
  "email/shell.greeting_named": "Hi {name},",
  "email/shell.unsubscribe": "Unsubscribe",

  // --- Severity, which is words first and color second (see `severity.ts`) ---
  "email/severity.info": "Notice",
  "email/severity.warning": "Action needed",
  "email/severity.critical": "Critical",

  // --- magicLink ---
  "email/magic_link.subject": "Your sign-in link",
  "email/magic_link.heading": "Sign in",
  "email/magic_link.instruction": "use the button below to sign in.",
  "email/magic_link.expiry.one": "It expires in {count} minute.",
  "email/magic_link.expiry.other": "It expires in {count} minutes.",
  "email/magic_link.cta": "Sign in",
  "email/magic_link.ignore": "If you didn't request this, you can ignore this email.",
  "email/magic_link.text_instruction.one": "Use this link to sign in (expires in {count} minute):",
  "email/magic_link.text_instruction.other": "Use this link to sign in (expires in {count} minutes):",
  "email/magic_link.text_ignore": "If you didn't request this, ignore this email.",

  // --- otp ---
  "email/otp.subject": "Your verification code",
  "email/otp.heading": "Your code",
  "email/otp.lead": "your verification code is:",
  "email/otp.expiry.one": "It expires in {count} minute.",
  "email/otp.expiry.other": "It expires in {count} minutes.",
  "email/otp.text_body.one": "Your verification code is {code}. It expires in {count} minute.",
  "email/otp.text_body.other": "Your verification code is {code}. It expires in {count} minutes.",

  // --- welcome ---
  "email/welcome.subject": "Welcome to {app}",
  "email/welcome.heading": "Welcome to {app}",
  "email/welcome.body": "Hi {name}, welcome to {app}. We're glad you're here.",
  "email/welcome.text_body": "Welcome to {app}. We're glad you're here.",

  // --- securityAlert ---
  "email/security_alert.subject": "Security alert: {event}",
  "email/security_alert.heading": "Security alert",
  "email/security_alert.body": "{event} on {when}.",
  "email/security_alert.ip": "IP address: {ip}.",
  "email/security_alert.text_ip": "IP: {ip}.",
  "email/security_alert.reassure": "If this was you, no action is needed.",
  "email/security_alert.cta": "Review activity",
  "email/security_alert.text_action": "If this wasn't you, secure your account:",

  // --- invite ---
  "email/invite.subject": "{inviter} invited you to {organization}",
  "email/invite.heading": "You're invited",
  // The organization name lost its `<strong>` when this sentence moved into the catalog, deliberately.
  // Markup in a catalog value is the one thing `interpolate` refuses to reason about, and splitting the
  // sentence into three fragments so the middle one could be bold would pin English word order into
  // every translation of it. A bold noun is not worth a sentence that cannot be reordered.
  "email/invite.body": "{inviter} invited you to join {organization} on {app}.",
  "email/invite.cta": "Accept invitation",
  "email/invite.text_accept": "Accept:",

  // --- passwordChanged ---
  "email/password_changed.subject": "Your password was changed",
  "email/password_changed.heading": "Your password was changed",
  "email/password_changed.body": "your account credentials were changed on {when}.",
  "email/password_changed.warn": "If this wasn't you, contact support immediately.",
  "email/password_changed.cta": "Contact support",
  "email/password_changed.text_body":
    "Your account credentials were changed on {when}. If this wasn't you, contact support:",

  // --- leadCapture ---
  "email/lead_capture.subject": "Your download: {asset}",
  "email/lead_capture.heading": "Your download is ready",
  // Same trade as `invite.body`: the asset name was `<strong>` and is now plain, because the
  // alternative is a sentence assembled from fragments in English order.
  "email/lead_capture.ready": "Your copy of {asset} is ready.",
  "email/lead_capture.cta": "Download now",
  "email/lead_capture.text_ready": "Your copy of {asset} is ready:",
};

/**
 * This capability's `Capability.messages` contribution — **English only, and that is the rule.**
 *
 * A kit package contributes the language it is written in; the translations of it ship in
 * `@pithy-sh/i18n` (`src/catalogs/<locale>/email.ts`), so a corrected sentence or a new locale reaches
 * every adopter as a package upgrade rather than as a merge into files they own. Keys are all under
 * `email/`, which `composeMessages` enforces.
 */
/**
 * Every language this capability's own copy is written in.
 *
 * **Bundled, not stamped.** The send Worker is deployed with this map inside it, so adding a language
 * to the kit costs an adopter a package upgrade and no configuration at all — which is the whole of
 * #442. What still travels as a variable is the adopter's diff against this: usually nothing, and at
 * most the sentences they changed.
 */
export const EMAIL_MESSAGES: LocaleCatalogs = { en: EMAIL_EN, es: EMAIL_ES };

/**
 * How the render engine finds words for a locale: the catalogs to walk, most-specific first.
 *
 * The same shape `@pithy-sh/i18n` already exposes as `layersFor`, so a composed project hands its own
 * — adopter overrides, the kit's translation, every capability's English — straight through, and this
 * package never imports that one. Absent, {@link kitEmailLayers} answers, which is what makes the i18n
 * capability optional here exactly as it is everywhere else.
 */
export type EmailMessageLayers = (locale: string) => readonly (MessageCatalog | undefined)[];

/** The layers a project that composed no i18n capability walks: this package's own English, and nothing else. */
export const kitEmailLayers: EmailMessageLayers = (locale) => [EMAIL_MESSAGES[locale], EMAIL_EN];

/** The primary language subtag of a tag — `es` of `es-AR`. Null when it is not a tag at all. */
function languageOf(tag: string): string | null {
  return parseLocale(tag)?.language ?? null;
}

/**
 * The layers behind a serialized catalog set — what the prebuilt email host worker uses.
 *
 * That worker is standalone: nothing composes capabilities inside it, so it cannot be handed a
 * composed project's `layersFor`. It reads the catalogs as one JSON var instead, and this turns them
 * into the same seam. English stays last, so a locale that translated nine sentences out of ten still
 * renders the tenth rather than its key.
 */
/**
 * The prefix every per-locale catalog variable carries on the email and testers hosts.
 *
 * **One variable per locale, not one variable holding every locale.** Cloudflare's 5 KB ceiling is per
 * variable, and a Worker gets 64 of them on the free plan and 128 on paid — so a project shipping
 * twenty languages has twenty 3 KB values, each comfortably inside the limit, rather than one 62 KB
 * value that is refused outright.
 *
 * It was one variable at first, and the ceiling that produced was absurd on inspection: every language
 * pack fits with 2 KB to spare, and the project still could not deploy a second one. Nothing about the
 * data was near a limit — the limit was manufactured by concatenating packs that are read one at a
 * time. The host renders one email, in one locale, from the job's row; it never needs the other
 * nineteen. Splitting the transport is the whole fix, and the in-memory shape is unchanged.
 */
export const EMAIL_CATALOG_VAR_PREFIX = "EMAIL_MESSAGES_";

/**
 * The variable name a locale's catalog travels under — `es-AR` becomes `EMAIL_MESSAGES_ES_AR`.
 *
 * Upper-cased with dashes as underscores, which is the shape a Worker variable name takes. The mapping
 * is injective because `Locale` forbids `_` in a tag, so no two tags can collide on one name.
 */
export function emailCatalogVarName(locale: string): string {
  return `${EMAIL_CATALOG_VAR_PREFIX}${locale.replaceAll("-", "_").toUpperCase()}`;
}

/**
 * The locale a variable name carries, or `null` when the name is not one of ours.
 *
 * **Canonicalized through `Intl`, not merely lower-cased.** A variable name has one case and a tag has
 * three — `pt-BR`, `zh-Hant-TW`, `es-419` — so the name alone cannot say which. `Intl.Locale` restores
 * it: `pt_br` reads back as `pt-BR`, script subtags title-cased and regions upper-cased, which is the
 * spelling `catalogLayers` looks the catalog up under. Lower-cased instead, a `pt-BR` job would miss a
 * `pt-br` catalog and silently render the kit's English.
 */
export function localeFromCatalogVar(name: string): string | null {
  if (!name.startsWith(EMAIL_CATALOG_VAR_PREFIX)) return null;
  const tag = name.slice(EMAIL_CATALOG_VAR_PREFIX.length).replaceAll("_", "-").toLowerCase();
  if (tag.length === 0) return null;
  return parseLocale(tag)?.baseName ?? null;
}

/**
 * Every catalog this host was deployed with, collected off the raw env.
 *
 * **Read from the raw env rather than declared on `EmailHostEnv`**, because the variable *names* are
 * the project's locales and a Zod object can only declare names known when it was written. The values
 * are still validated — each one is parsed through `LocaleCatalogs`' own `MessageCatalog`, so a
 * variable holding something that is not a catalog is a boot failure rather than a render failure.
 *
 * A locale whose value will not parse is skipped rather than fatal: the render falls through to the
 * kit's English for that language and every other language still works. One unreadable variable
 * should not stop a host from sending mail.
 */
export function catalogsFromEnv(env: Record<string, unknown>): LocaleCatalogs {
  const catalogs: LocaleCatalogs = {};
  for (const [name, raw] of Object.entries(env)) {
    const locale = localeFromCatalogVar(name);
    if (locale === null || typeof raw !== "string" || raw.trim().length === 0) continue;
    try {
      const parsed = MessageCatalog.safeParse(JSON.parse(raw));
      if (parsed.success) catalogs[locale] = parsed.data;
    } catch {
      // Not JSON. Skipped for the same reason an unparseable one is: the other locales still send.
    }
  }
  return catalogs;
}

export function catalogLayers(catalogs: LocaleCatalogs): EmailMessageLayers {
  return (locale) => {
    const language = languageOf(locale);
    // `es-AR` reads the `es` catalog. The reduction happens here rather than in
    // {@link emailTranslator} because this is the only seam that can *see* the whole catalog map and
    // therefore answer whether the region was written for; a translator that appended a second layer
    // set blindly would put the first set's English fallback ahead of the second set's Spanish, which
    // is a regional reader silently getting the source language. A composed project does not reach
    // this path: `@pithy-sh/i18n` negotiates `es-AR` down to `es` at the request, before a locale is
    // ever stored or enqueued.
    const exact = catalogs[locale] ?? (language ? catalogs[language] : undefined);
    return [exact, EMAIL_MESSAGES[locale], EMAIL_EN];
  };
}

/**
 * The tag this render will actually be written in — the one it was asked for, or the kit's default.
 *
 * **The guard is here because this is the last place before `Intl`.** `Translator.plural` builds an
 * `Intl.PluralRules` on the catalog locale, and `Intl` refuses tags that look perfectly well formed:
 * `en-x`, `en-t`, `en-u`, `en-1`, `en-US-x` and `en-a-bbb-a-ccc` are a singleton subtag with nothing
 * after it, or a repeated extension, and every one of them raises `RangeError`. `magicLink` and `otp`
 * — the two sends the whole of authentication rests on — render `{{tn}}`, so that throw lands inside
 * `renderEmail`: at enqueue it is a raw `RangeError` out of a request handler rather than a
 * `PithyError`, and at send it is one inside the send Workflow, where `classifySendError` sees no code
 * it knows and the job burns its retries and wedges.
 *
 * `@pithy-sh/core`'s `Locale` refuses the same six on the way into D1, and that is the repair that
 * matters — a tag `Intl` will not take should never reach `pithy_email_jobs.locale`. This is the
 * belt: the two callers here (`enqueueEmail`, `runSend`) take a bare `string`, one of them *before*
 * anything has been validated, and a row written by an adopter's own SQL or by a build that predates
 * that refinement is still a row this Worker has to render. Falling back costs a message in the wrong
 * language; not falling back costs the message.
 */
function renderLocale(locale: string | null | undefined): string {
  const tag = locale?.trim();
  if (!tag) return DEFAULT_LOCALE;
  return parseLocale(tag) === null ? DEFAULT_LOCALE : tag;
}

/**
 * The translator one email renders through.
 *
 * **Built per render from the job's own locale, never from the request's.** A send happens inside a
 * Workflow hours or days after the enqueue, in a Worker with no request on it at all, so `c.var.t` —
 * the seam every HTTP surface uses — does not exist at the moment that matters. The locale is on the
 * row for exactly that reason, and this is what turns it back into words.
 *
 * **The two locales stay apart.** `catalogLocale` is the tag as stored — it is what the document
 * declares itself as and what decides text direction — and `formattingLocale` is the same tag handed to
 * `Intl`, so an Argentine reading Spanish still gets Argentine numbers and dates. Collapsing them is
 * the bug `Translator` carries two fields to prevent. Which *catalog* answers a regional tag is
 * {@link catalogLayers}'s question, not this one's.
 *
 * Both of them come from {@link renderLocale}, so a tag `Intl` refuses can reach neither.
 */
export function emailTranslator(locale: string | null | undefined, layersFor: EmailMessageLayers): Translator {
  const tag = renderLocale(locale);
  return createTranslator({ catalogLocale: tag, formattingLocale: tag, layers: layersFor(tag) });
}
