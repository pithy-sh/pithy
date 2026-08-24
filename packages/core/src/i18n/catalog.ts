// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { Locale } from "./locale";

/**
 * The grammar of a catalog key: `<domain>/<path>`.
 *
 * `<domain>` is a capability's `name` — the same segment that is already the `pithy add` argument, the
 * migration namespace, the `pithy_<name>_*` table prefix and the error-code domain. `<path>` is that
 * capability's own name for the string, and may carry dots for the screens (`auth/sign_in.title`).
 *
 * **For an error the key *is* the code.** `auth/invalid_token` is a catalog key and an error code and
 * the same string, so there is no second identifier to keep in sync, and `KitErrorCode` is the
 * exhaustive checklist a locale has to cover.
 *
 * **Which is why the domain admits `_` as well as the tail**, and it is the same reason: this grammar
 * has to accept every code the taxonomy already spells, and `rate_limit/exceeded` is one of them. It
 * did not, at first — the domain was `[a-z][a-z0-9]*` while the tail was `[a-z][a-z0-9]*(?:_…)*`, so
 * the single most-thrown code in the kit was a valid error code and an invalid catalog key. The kit's
 * own Spanish carried it anyway (a translating client renders `t.maybe(payload.code, payload.params) ??
 * payload.message` for whatever it is sent), and an adopter trying to override that one sentence was
 * refused by their own config. A grammar narrower than the thing it names is not stricter, it is wrong.
 */
const MESSAGE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\/[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;

/** The longest catalog key. Bounds the domain check and matches the error taxonomy's own ceiling. */
const MAX_MESSAGE_KEY_LENGTH = 129;

/** A catalog key — `<domain>/<path>`, where `<domain>` is the contributing capability's name. */
export const MessageKey = z
  .string()
  .max(MAX_MESSAGE_KEY_LENGTH)
  .regex(MESSAGE_KEY, { message: "A message key is `<domain>/<path>`, where the domain is a capability name." })
  .describe("A catalog key, `<domain>/<path>` — for an error, the error code itself.");
export type MessageKey = z.infer<typeof MessageKey>;

/** The values a message may interpolate. Scalars only — a catalog renders text, never a structure. */
export const MessageParams = z
  .record(
    z.string().describe("The placeholder name, as written between braces in the message."),
    z
      .union([z.string(), z.number(), z.boolean()])
      .describe("The value substituted for that placeholder. Scalar, so a message stays a sentence."),
  )
  .describe("Values a message interpolates, keyed by placeholder name.");
export type MessageParams = z.infer<typeof MessageParams>;

/** One locale's words: key → message. */
export const MessageCatalog = z
  .record(MessageKey.describe("The key this message answers."), z.string().describe("The message, in this locale."))
  .describe("One locale's messages, keyed by `<domain>/<path>`.");
export type MessageCatalog = z.infer<typeof MessageCatalog>;

/** A set of catalogs, keyed by locale — what a capability contributes and what an adopter overrides with. */
export const LocaleCatalogs = z
  .record(Locale.describe("The locale these messages are written in."), MessageCatalog)
  .describe("Catalogs keyed by locale — a capability's `messages` contribution, or an adopter's overrides.");
export type LocaleCatalogs = z.infer<typeof LocaleCatalogs>;

/** The domain of a catalog key — everything before the `/`. */
export function messageDomain(key: string): string {
  const cut = key.indexOf("/");
  return cut < 0 ? key : key.slice(0, cut);
}

/**
 * `template` with every `{placeholder}` replaced by its parameter.
 *
 * A placeholder with no parameter is **left as written**, not blanked. A missing value is a bug in the
 * call site or a typo in the catalog, and `Renews {date}.` on the screen says which; `Renews .` says
 * nothing and reads like finished copy.
 *
 * Substitution is textual and performs no escaping, because the two consumers escape differently and
 * both do it better than this could: React escapes what it renders, and the email engine precompiles
 * `subject` and `text` with `noEscape` deliberately. A catalog value reaching an unescaped surface is
 * therefore a fact about that surface — stated in `docs/I18N.md`, and the reason kit catalogs carry no
 * markup.
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  // `Object.hasOwn`, never a bare index. A plain object inherits `constructor`, `toString` and the
  // rest, so `params[name]` answers a native function for a placeholder nobody passed — and
  // `{constructor}` in a message then renders `function Object() { [native code] }` into user-facing
  // copy, which is the opposite of the promise two paragraphs up.
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    if (!Object.hasOwn(params, name)) return whole;
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * The first layer that has `key`, or `null` when none does.
 *
 * **Per key, never per catalog.** An adopter who translates one sentence passes one entry, and every
 * key they did not mention keeps flowing from the package — which is what makes an override a merge
 * rather than a fork. Layer order is the caller's: `@pithy-sh/i18n` walks adopter-locale, then
 * adopter-default, then kit-locale, then kit-default.
 */
export function lookupMessage(layers: readonly (MessageCatalog | undefined)[], key: string): string | null {
  for (const layer of layers) {
    // Own keys only. A catalog is a plain object, so `layer["constructor"]` answers `Object` itself —
    // and a lookup that returned it would hand a *function* to `interpolate`, which calls `.replace`
    // on it. `t` is documented as total; walking the prototype chain is how it stops being.
    if (layer && Object.hasOwn(layer, key)) {
      const message = layer[key];
      if (message !== undefined) return message;
    }
  }
  return null;
}
