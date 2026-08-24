// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import { ValidationError } from "../error/pithyError";
import { type LocaleCatalogs, type MessageCatalog, messageDomain } from "./catalog";
import { DEFAULT_LOCALE } from "./translator";

/** One capability's contribution, kept beside the capability that made it so a refusal can name it. */
interface Contribution {
  /** The contributing capability's `name` — the only domain it may write keys under. */
  readonly capability: string;
  /** That capability's catalogs, keyed by locale. */
  readonly catalogs: LocaleCatalogs;
}

/**
 * Every composed capability's `messages`, merged into one set of catalogs keyed by locale.
 *
 * **A capability may only declare keys under its own domain**, and the merge refuses anything else.
 * That is the same rule as `pithy_<capability>_<table>` and `auth/invalid_token`, enforced for the same
 * reason: the domain segment is what makes two capabilities' contributions incapable of colliding, so
 * merge order stops being a thing anyone has to reason about. It applies to the adopter's own `app`
 * capability exactly as it applies to a kit package — `board/nav.settings` is theirs to declare, and
 * `auth/sign_in.title` is not.
 *
 * Library-before-app, like the migration registry: capabilities are merged in composition order, so a
 * later contribution wins a key an earlier one wrote. With the domain rule in force that can only
 * happen between two capabilities sharing a name, which `createBackend` already refuses.
 */
export function composeMessages(capabilities: readonly Capability[]): LocaleCatalogs {
  const contributions: Contribution[] = [];
  for (const capability of capabilities) {
    if (capability.messages) contributions.push({ capability: capability.name, catalogs: capability.messages });
  }
  // **Accumulated in a `Map`, not in an object literal, and that is not a style preference.**
  //
  // `Object.entries` really does hand back an own `__proto__` key — `JSON.parse('{"__proto__":{}}')`
  // creates one, and a capability's `messages` can arrive from parsed JSON. Assigning `merged[locale]`
  // for that key goes *through* the inherited setter rather than into the map: the locale is silently
  // lost, and the object's prototype is replaced. Guarding the read with `Object.hasOwn` does not help,
  // because the hazard is the write. A `Map` has no prototype chain to walk and no setter to trip, and
  // `Object.fromEntries` defines rather than assigns, so the object handed back is an ordinary one
  // with an ordinary prototype.
  //
  // Only an adopter's own capability could reach this, in their own runtime, so it is a consistency
  // fix rather than a vulnerability — but the rest of this merge path is hardened and a lone exception
  // is the one somebody copies.
  const merged = new Map<string, Map<string, string>>();
  for (const { capability, catalogs } of contributions) {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const target = merged.get(locale) ?? new Map<string, string>();
      for (const [key, message] of Object.entries(catalog)) {
        const domain = messageDomain(key);
        if (domain !== capability) {
          throw new ValidationError({
            message: "A capability may only contribute messages under its own domain.",
            action: `Rename \`${key}\` to start with \`${capability}/\`, or move it to the capability that owns that domain.`,
            detail: `\`${capability}\` contributed \`${key}\` in locale \`${locale}\`, whose domain is \`${domain}\`.`,
          });
        }
        target.set(key, message);
      }
      merged.set(locale, target);
    }
  }
  return Object.fromEntries([...merged].map(([locale, catalog]) => [locale, Object.fromEntries(catalog)]));
}

/**
 * The catalog for `locale`, or the default locale's, or an empty one.
 *
 * The fallback that makes the seam optional: a Worker composing no i18n capability reads the baked
 * English and behaves byte for byte as it did before any of this landed.
 */
export function catalogFor(catalogs: LocaleCatalogs, locale: string): MessageCatalog {
  return catalogs[locale] ?? catalogs[DEFAULT_LOCALE] ?? {};
}
