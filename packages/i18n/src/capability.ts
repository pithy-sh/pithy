// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { LocaleCatalogs, MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { catalogFor, composeMessages } from "@pithy-sh/core/src/i18n/registry";
import { KIT_CATALOGS } from "./catalogs/kit";
import type { I18nClientProjection } from "./client/projection";
import { I18nConfig, type I18nConfigInput } from "./config/config";
import { i18nMiddleware } from "./http/middleware";
import { i18nSettings } from "./settings/coverage";
import { PACKAGE_VERSION } from "./version.generated";

/**
 * The i18n capability, with its resolved config and the catalogs it composed attached for inspection.
 *
 * The composed catalogs are populated by the `compose` hook rather than at construction, because a
 * capability sees only itself when it is constructed and the kit's English lives on the capabilities
 * that own it.
 */
export interface I18nCapability extends Capability {
  /** The validated config, for `@pithy-sh/ui-react` and anything else that needs the negotiated set. */
  i18nConfig: I18nConfig;
  /** Every composed capability's English, merged under the domain rule. Empty until `compose` runs. */
  composedMessages: LocaleCatalogs;
  /** The catalog layers `t()` walks for `locale`, most-specific first. */
  layersFor(locale: string): readonly (MessageCatalog | undefined)[];
}

/**
 * The i18n capability.
 *
 * **Stateless, like `@pithy-sh/turnstile`** — no tables, no migrations, no `<NAME>_MIGRATION_ORDER`, no
 * error codes, no bindings of its own. It contributes one middleware, which resolves the request's
 * locale and replaces `c.var.t` with a translator over the merged catalogs.
 *
 * It declares no error codes deliberately. The moment an `i18n/*` code entered `KitErrorPayload` the
 * whole `i18n` domain would be reserved against adopters, and `i18n` is a generic enough word that
 * somebody has already defined `i18n/missing_catalog` through `defineErrorPayload`. Nothing here needs
 * a code that `core/*` and `validation/*` do not already carry.
 *
 * ## What the layers are, and why the order is this
 *
 * `t(key)` walks, per key, in this order:
 *
 * 1. the adopter's catalog for the resolved locale,
 * 2. the adopter's catalog for the project default,
 * 3. **the kit's translation** for the resolved locale — the `es` this package ships,
 * 4. every composed capability's English, for the resolved locale,
 * 5. that same English for the project default.
 *
 * Per key, never per catalog: overriding one sentence is one entry, and every key an adopter did not
 * mention keeps flowing from the package. That is what makes an override a merge rather than a fork,
 * and it is why kit catalogs are never copied into an adopter's repository.
 *
 * Errors are not in any of those layers and do not need to be: the payload already carries its English
 * `message`, and a translating client renders `t.maybe(payload.code, payload.params) ?? payload.message`. So
 * the kit ships translations for the 120 codes and no English duplicate of what is already on the wire.
 */
export function i18n(config: I18nConfigInput = {}): I18nCapability {
  const resolved = I18nConfig.parse(config);
  let composedMessages: LocaleCatalogs = {};

  const layersFor = (locale: string): readonly (MessageCatalog | undefined)[] => [
    resolved.messages[locale],
    resolved.messages[resolved.defaultLocale],
    KIT_CATALOGS[locale],
    composedMessages[locale],
    catalogFor(composedMessages, resolved.defaultLocale),
  ];

  const capability = defineCapability({
    name: "i18n",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    config: I18nConfig,
    /**
     * Merge every composed capability's English once, at assembly.
     *
     * Here rather than at construction because a capability sees only itself when it is built, and the
     * kit's English is contributed by the capabilities that own it — `@pithy-sh/email`'s template copy
     * under `email/`, an adopter's own `app` capability under theirs. `composeMessages` enforces that
     * each may only write keys under its own domain.
     */
    compose: ({ capabilities }) => {
      composedMessages = composeMessages(capabilities);
    },
    middleware: [i18nMiddleware(resolved, layersFor)],
    /**
     * Locale **metadata**, never catalogs. `renderVirtualModule` inlines this as a `JSON.stringify`
     * literal in the main chunk, so a catalog here would be downloaded by every reader in every
     * language before first paint and would defeat the per-locale splitting the design rests on.
     *
     * The return type is {@link I18nClientProjection} — declared, not inferred, so a dropped field is a
     * compile error here rather than a browser's problem.
     */
    client: (): I18nClientProjection => ({
      enabled: true,
      supportedLocales: [...resolved.supportedLocales],
      defaultLocale: resolved.defaultLocale,
      queryParam: resolved.queryParam,
      storageKey: resolved.storageKey,
      browserResolvers: [...resolved.browserResolvers],
      exceptions: { ...resolved.exceptions },
    }),
    /**
     * Catalog coverage, as `pithy doctor`'s local tier rather than as a `pithy i18n check` command.
     *
     * It is offline, project-file-only, and a local finding already fails `doctor`'s exit code — which
     * is exactly what the command would have been, at the cost of a new page in `docs/commands/`, a
     * row in five exact-count CLI gates, and a byte-pinned re-paste of `pithy --help`.
     */
    settings: i18nSettings(resolved, () => composedMessages),
    requiredBindings: [],
  });

  const composed = Object.assign(capability, { i18nConfig: resolved, layersFor });
  // `composedMessages` is defined on the target rather than declared in the literal above, and that is
  // not a style choice. `Object.assign` **reads** an accessor on its source and copies the value it
  // returned, so a `get composedMessages()` in that literal would be evaluated once — before `compose`
  // has run — and every reader would see the empty object it held at construction, permanently.
  // Defined here it stays an accessor over the live binding, which is what the interface promises.
  Object.defineProperty(composed, "composedMessages", { get: () => composedMessages, enumerable: true });
  return composed as I18nCapability;
}

/** Whether a capability is the i18n capability — carries its resolved config and composed catalogs. */
export function isI18nCapability(capability: Capability): capability is I18nCapability {
  return capability.name === "i18n" && "i18nConfig" in capability;
}
