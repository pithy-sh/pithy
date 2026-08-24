// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a browser may know about this project's languages — the shape of `virtual:pithy/i18n`.
 *
 * **Locale metadata only. Never catalogs.** `renderVirtualModule` emits the projection as an inline
 * `JSON.stringify` literal in the main chunk, so a catalog carried here would be downloaded by every
 * reader in every language before the first paint, and would defeat the per-locale code splitting the
 * design is built on. Catalogs reach the browser by dynamic import, one Vite chunk per locale.
 *
 * **This declaration is the contract, and the projection is checked against it.** It is written here
 * rather than inferred from the closure that builds it: an inferred type follows whatever the producer
 * last happened to say, so a projection that dropped a field would take the type with it and nothing
 * would go red. Declared, the arrow is what has to change.
 *
 * **This is the only statement of the shape.** `@pithy-sh/ui-react`'s `templates/client-env.d.ts` — the
 * ambient declaration `pithy ui add react` copies into an adopter's Worker — is generated from this
 * type by `@pithy-sh/vite`'s `clientEnvDeclaration.ts`, doc comments and all. What is written here is
 * what a screen author reads.
 */
export type I18nClientProjection =
  | {
      /**
       * The i18n capability is not composed. Every screen renders the English it was scaffolded with,
       * byte for byte as it did before any of this landed — which is what makes the capability optional.
       */
      enabled: false;
    }
  | {
      /** The i18n capability is composed, and these are the languages this project serves. */
      enabled: true;
      /** Every locale this project serves, as BCP-47 tags. The browser negotiates within this set. */
      supportedLocales: string[];
      /** The locale served when nothing in the browser chain answers. Always in `supportedLocales`. */
      defaultLocale: string;
      /** The query parameter an explicit choice arrives on — `?lang=es`. */
      queryParam: string;
      /** The `localStorage` key this device's remembered locale is written under. */
      storageKey: string;
      /**
       * The browser chain, in the order it is asked: `query`, `account`, `storage`, `server`, `default`.
       * Projected so the front end resolves in the order the project configured, not one it assumed.
       */
      browserResolvers: string[];
      /**
       * Language ranges the matcher cannot derive, as range → supported locale. Usually empty; it
       * carries the historical pairs (`nb` meaning `no`) that no truncation of a tag would reach.
       */
      exceptions: Record<string, string>;
    };
