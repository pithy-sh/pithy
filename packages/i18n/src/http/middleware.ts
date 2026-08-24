// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { createTranslator, type Translator } from "@pithy-sh/core/src/i18n/translator";
import { getCookie } from "hono/cookie";
import type { I18nConfig } from "../config/config";
import type { ResolvedLocale } from "../resolve/chain";
import { resolveServerLocale } from "../resolve/server";

/** How a request's locale is looked up, given the locale that won. Supplied by the capability. */
export type LayersFor = (locale: string) => readonly (MessageCatalog | undefined)[];

/**
 * The one middleware this capability contributes: resolve the request's locale, and put a real
 * translator on it.
 *
 * It **replaces** `c.var.t` rather than filling a null. Core seeds a translator over the baked English
 * for every request whether or not this capability is composed, which is what lets every capability
 * call `c.var.t(...)` with no null check, and what makes a project that never opts in behave byte for
 * byte as it did before.
 *
 * A fresh translator per request, never a cached one. A Worker isolate is reused across requests from
 * different readers, so anything holding a locale across that boundary applies request A's language to
 * request B. It is the same hazard `z.config()` is banned repo-wide for, and it is why the `Intl`
 * formatters are held on the translator — which lives and dies with one request — rather than in a
 * module-level cache.
 *
 * ## Why the query string is read off the URL here, and not through `zValidator`
 *
 * §HTTP's rule is that a route declares its request contract on the route line and a handler reads
 * `c.req.valid(target)`; `plugins/no-raw-request-input.grit` enforces it by making the raw accessors
 * unreadable under every capability's `src/http/` tree. This is a **global middleware over every route**, so there
 * is no route line to declare a validator on and no handler to hand a typed value to — the rule's
 * replacement does not exist at this position.
 *
 * What the rule is *for* still holds, and it holds structurally rather than by care: the value is one
 * language range among four sources, every one of them is matched against `config.supportedLocales`
 * before anything is done with it, and a range that matches nothing falls through to the next link.
 * Nothing downstream ever sees a string this middleware did not already find in the project's own
 * configured set. A reader who sends `?lang=<script>` gets the default locale.
 */
export function i18nMiddleware(config: I18nConfig, layersFor: LayersFor): PithyMiddleware {
  return (app) => {
    app.use("*", async (c, next) => {
      // **Resolved on first read, not here, and that is what makes the `user` link work at all.**
      //
      // `createBackend` applies each capability's middleware in composition order — the order an
      // adopter happened to list them in `pithy.config.ts`. Resolving eagerly therefore reads
      // `c.var.auth` before `@pithy-sh/auth` has filled it whenever i18n is listed first, and the
      // reader's stored language is silently dropped for half of all projects. Nothing fails; the
      // chain just quietly becomes `param → cookie → header → default`.
      //
      // Both are `app.use("*")`, so both have run by the time any handler reads `c.var.t`. Deferring
      // the resolution to that first read makes the answer identical in either order, which is a
      // property rather than a convention — there is no ordering left to get wrong.
      let resolved: ResolvedLocale | undefined;
      const locale = (): ResolvedLocale =>
        (resolved ??= resolveServerLocale(
          {
            param: queryParam(c.req.url, config.queryParam),
            // The reader's own stored choice, off the row the session lookup already loaded.
            user: c.var.auth?.locale ?? null,
            cookie: getCookie(c, config.cookie) ?? null,
            header: c.req.header("accept-language") ?? null,
          },
          config,
        ));

      let translator: Translator | undefined;
      const t = (): Translator =>
        (translator ??= createTranslator({
          catalogLocale: locale().catalogLocale,
          formattingLocale: locale().formattingLocale,
          layers: layersFor(locale().catalogLocale),
        }));

      c.set("locale", {
        get catalogLocale() {
          return locale().catalogLocale;
        },
        get formattingLocale() {
          return locale().formattingLocale;
        },
        get direction() {
          return locale().direction;
        },
      });

      // Every member delegates, so nothing is negotiated for a request that renders no copy — a health
      // check and a webhook pay nothing for a capability the rest of the Worker composes.
      c.set("t", {
        get catalogLocale() {
          return t().catalogLocale;
        },
        get formattingLocale() {
          return t().formattingLocale;
        },
        get direction() {
          return t().direction;
        },
        t: (key, params) => t().t(key, params),
        maybe: (key, params) => t().maybe(key, params),
        plural: (key, count, params) => t().plural(key, count, params),
        formatNumber: (value, options) => t().formatNumber(value, options),
        formatCurrency: (value, currency, options) => t().formatCurrency(value, currency, options),
        formatDate: (value, options) => t().formatDate(value, options),
        formatList: (values, options) => t().formatList(values, options),
        formatRelativeTime: (value, unit, options) => t().formatRelativeTime(value, unit, options),
      } satisfies Translator);

      await next();
    });
  };
}

/** One query parameter off a request URL, or `null` — total, so a URL Hono accepted cannot throw here. */
function queryParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
}
