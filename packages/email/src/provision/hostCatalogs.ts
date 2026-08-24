// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import type { LocaleCatalogs, MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { EMAIL_MESSAGES, type EmailMessageLayers } from "../templates/messages";

/**
 * The catalogs the prebuilt email host worker is deployed with — the provision-time half of
 * `catalogLayers`.
 *
 * ## Why the host needs data where the app worker needs a seam
 *
 * An app worker composes capabilities, so `@pithy-sh/email`'s enqueue reaches a composed project's
 * `layersFor` through the `compose` hook and renders a subject in whatever language the project
 * speaks. The host worker composes nothing: `pithy email provision` deploys it from a committed
 * template, and no `pithy.config.ts` of the adopter's is ever evaluated inside it. So the layers
 * cannot travel as a function; they travel as one JSON var, and this is what flattens them.
 *
 * Nothing wrote that var before pithy-sh/pithy#441's remediation, which made the whole translated-body
 * path dead in any real deployment: the send Workflow rendered the kit's English whatever tag was on
 * the row, and — because `runSend` overwrites the stored subject with its own fresh render — discarded
 * the translated subject the app worker had computed at enqueue as well. Two Workers, one message, and
 * they disagreed about its language.
 *
 * ## What is dropped, and why dropping it changes nothing
 *
 * **Only `email/` keys.** The host renders email templates and nothing else, so a screen's copy or an
 * error's translation in this var is weight against a hard 5 KB ceiling (see `resolveEmailConfig`) for
 * a key no template will ever ask for.
 *
 * **And only keys that say something the host does not already have.** `catalogLayers` ends every
 * lookup at `EMAIL_MESSAGES` — this package's own English, bundled into the host — so a key whose
 * merged value is byte-identical to that English resolves to the same string whether it is in the var
 * or not. Leaving it out is therefore invisible in the rendered mail and is the difference between a
 * project fitting in the var and being refused by it. An adopter who overrode an English sentence is
 * unaffected: their value is not the kit's, so it stays.
 */

/** The domain every key this capability renders lives under — `composeMessages` enforces it too. */
const EMAIL_KEY_PREFIX = "email/";

/**
 * The `email/*` keys that are **error codes**, not template copy.
 *
 * The prefix alone is not the rule the doc below states. `email/send_failed` and its five siblings are
 * catalog keys under this capability's domain because for an error the key *is* the code — but no
 * template ever asks for one, and the host is the Worker that renders templates. A client translates
 * an error from a catalog it already holds; the send Workflow never renders one.
 *
 * Worth the derivation rather than a list: it is 416 bytes of a 5120-byte ceiling that a real project
 * already fills to 69%, so it is roughly 8% of the room a second locale would need. Read off
 * `KitErrorPayload` so a seventh `email/*` code drops out on its own.
 */
const EMAIL_ERROR_CODES: ReadonlySet<string> = new Set(
  KitErrorPayload.options.map((member) => member.shape.code.value).filter((code) => code.startsWith(EMAIL_KEY_PREFIX)),
);

/** Whether a key is copy this host will actually render. */
function rendersOnTheHost(key: string): boolean {
  return key.startsWith(EMAIL_KEY_PREFIX) && !EMAIL_ERROR_CODES.has(key);
}

/**
 * Flatten a composed project's layers into the `EMAIL_MESSAGES` var's value, one catalog per locale.
 *
 * `locales` is the project's `supportedLocales`; a project that composed no i18n capability passes
 * none, gets `{}`, and deploys a host with no var at all — which is the same English it always sent.
 */
export function emailHostCatalogs(locales: readonly string[], layersFor: EmailMessageLayers): LocaleCatalogs {
  const catalogs: LocaleCatalogs = {};
  for (const locale of locales) {
    const merged: MessageCatalog = {};
    // The layers arrive most-specific first, because that is the order `lookupMessage` walks them in.
    // Flattening runs the other way: the least specific lands first and the adopter's override writes
    // over it, so the value left standing is the one `t()` would have found.
    for (const layer of [...layersFor(locale)].reverse()) {
      for (const [key, value] of Object.entries(layer ?? {})) {
        if (rendersOnTheHost(key)) merged[key] = value;
      }
    }
    // **What travels is the adopter's diff, and nothing else (#442).**
    //
    // The host is deployed carrying `EMAIL_MESSAGES` — the kit's own copy in every language it is
    // written in — so a key whose merged value is already what the host holds for this locale is a
    // sentence it would render identically with no variable at all. Sending it is sending the Worker
    // words it was built with.
    //
    // It used to be compared against the English alone, which meant the kit's own Spanish rode along:
    // static data through a configuration channel, every provision run, against a 5 KB per-variable
    // ceiling that a language pack filled to 61%. Compared against the locale's own bundled copy, a
    // project that overrides nothing deploys no variable, and adding a language the kit ships costs no
    // configuration growth at all.
    //
    // The English fallback stays in the comparison because that is what the host renders for a key no
    // translation covers — dropping only against the locale would send back every untranslated key.
    const bundled = { ...(EMAIL_MESSAGES.en ?? {}), ...(EMAIL_MESSAGES[locale] ?? {}) };
    for (const [key, value] of Object.entries(merged)) {
      if (bundled[key] === value) delete merged[key];
    }
    if (Object.keys(merged).length > 0) catalogs[locale] = merged;
  }
  return catalogs;
}
