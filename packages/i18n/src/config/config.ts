// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { LocaleCatalogs } from "@pithy-sh/core/src/i18n/catalog";
import { Locale } from "@pithy-sh/core/src/i18n/locale";
import { z } from "zod";

/**
 * One link of the **server** resolver chain — the order a Worker asks "what language is this request in?".
 *
 * Split from the browser chain because `localStorage` does not exist in a Worker and
 * `navigator.language` inside workerd is the constant `"en"`, carrying no request information at all.
 * Two chains over one contract is honest; one chain with half its links inert is not.
 */
export const ServerResolver = z
  .enum(["param", "user", "cookie", "header", "default"])
  .describe("A link of the server resolver chain: an explicit param, the account, a cookie, the header, the default.");
export type ServerResolver = z.infer<typeof ServerResolver>;

/**
 * One link of the **browser** resolver chain.
 *
 * `account` sits above `storage` deliberately: `pithy_auth_users.locale` is where a person's locale
 * lives, so a signed-in reader's choice must not silently diverge per device. See `docs/I18N.md`.
 */
export const BrowserResolver = z
  .enum(["query", "account", "storage", "navigator", "server", "default"])
  .describe(
    "A link of the browser resolver chain: `?lang=`, the account, local storage, the browser's own languages, the server, the default.",
  );
export type BrowserResolver = z.infer<typeof BrowserResolver>;

/** The server chain's default order — explicit param, account, cookie, `Accept-Language`, project default. */
const DEFAULT_SERVER_RESOLVERS: readonly ServerResolver[] = ["param", "user", "cookie", "header", "default"];

/** The browser chain's default order — `?lang=`, account, local storage, the server's answer, default. */
/**
 * The browser chain's default order — `?lang=`, account, this device's memory, the reader's own
 * browser languages, what the server declared, the project default.
 *
 * **`navigator` sits above `server`, and that ordering is the whole reason the link exists.** The
 * `server` link reads `document.documentElement.lang`, and a scaffolded SPA is served from a static
 * `index.html` that says `lang="en"` with no substitution token — so without a browser link, a
 * first-time Spanish visitor to a project shipping `es` resolved to the default and read English on
 * every screen. Automatic negotiation worked on the server and nowhere else.
 *
 * Placing it above `server` costs a genuinely server-rendered app nothing: if that server negotiated,
 * it negotiated from `Accept-Language`, which is the same preference `navigator.languages` reports —
 * and anything it knew that the browser does not, the reader's account, is already ranked higher.
 */
const DEFAULT_BROWSER_RESOLVERS: readonly BrowserResolver[] = [
  "query",
  "account",
  "storage",
  "navigator",
  "server",
  "default",
];

/** The locale the kit writes in, and what every unconfigured project falls back to. */
const DEFAULT_LOCALE = "en";

/**
 * The i18n capability's configuration.
 *
 * Everything an adopter decides about language lives here, including their own catalogs — **a config
 * object passed to the capability, never files discovered on disk.** Two reasons, and both are hard
 * constraints rather than preferences. `configEntrypoints.test.ts` imports every capability's config
 * entry point in a plain Node process, so a catalog loader doing `readFileSync` at module scope breaks
 * `pithy upgrade`, `migrate` and `deploy` for every project composing it. And a catalog file copied
 * into an adopter's repository is a fork on the day they scaffold: a typo fix or a new locale could
 * never reach them again.
 */
export const I18nConfig = z
  .object({
    supportedLocales: z
      .array(Locale)
      .min(1)
      .default([DEFAULT_LOCALE])
      .describe("Every locale this project serves. Ship the least specific tag that is true — `es`, not `es-ES`."),
    defaultLocale: Locale.default(DEFAULT_LOCALE).describe(
      "The locale served when nothing else answers. Must be one of `supportedLocales`.",
    ),
    messages: LocaleCatalogs.default({}).describe(
      "This project's own catalogs. Overriding one kit key is one entry; everything unmentioned keeps flowing from the package.",
    ),
    exceptions: z
      .record(
        z.string().describe("The language range a reader sends that no truncation of it would match."),
        Locale.describe("The supported locale it means."),
      )
      .default({})
      // **Keys lower-cased on the way in, because the lookup lower-cases the range.** `matchLocale`
      // compares against a lower-cased range, so an exception written the way BCP-47 spells it —
      // `nb-NO`, which is exactly how somebody writes the pair this field documents — never matched and
      // failed silently, the reader falling through to the project default. Normalizing here rather
      // than indexing case-insensitively at the lookup keeps one spelling in the resolved config, so
      // what `pithy doctor` prints is what the matcher will use.
      .transform((exceptions) =>
        Object.fromEntries(Object.entries(exceptions).map(([range, locale]) => [range.toLowerCase(), locale])),
      )
      .describe("Language ranges the matcher cannot derive — historical pairs like `nb` meaning `no`."),
    cookie: z
      .string()
      .min(1)
      .default("pithy_locale")
      .describe("The cookie the server chain's `cookie` link reads a chosen locale from."),
    queryParam: z
      .string()
      .min(1)
      .default("lang")
      .describe("The query parameter an explicit choice arrives on, on both the server and the browser."),
    storageKey: z
      .string()
      .min(1)
      .default("pithy.locale")
      .describe("The `localStorage` key the browser chain's `storage` link reads and writes."),
    serverResolvers: z
      .array(ServerResolver)
      .min(1)
      .default([...DEFAULT_SERVER_RESOLVERS])
      .describe("The server chain, in the order it is asked. Reorder or shorten it; `default` is the last resort."),
    browserResolvers: z
      .array(BrowserResolver)
      .min(1)
      .default([...DEFAULT_BROWSER_RESOLVERS])
      .describe("The browser chain, in the order it is asked."),
  })
  .check((ctx) => {
    const { supportedLocales, defaultLocale } = ctx.value;
    if (!supportedLocales.includes(defaultLocale)) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["defaultLocale"],
        message: `\`${defaultLocale}\` is the default locale and is not in \`supportedLocales\`, so nothing would answer when negotiation fails.`,
      });
    }
    for (const locale of Object.keys(ctx.value.messages)) {
      if (!supportedLocales.includes(locale)) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["messages", locale],
          message: `\`${locale}\` carries messages and is not in \`supportedLocales\`, so nothing would ever read them.`,
        });
      }
    }
  })
  .describe("How this project negotiates and renders language, and the catalogs it adds of its own.");
export type I18nConfig = z.output<typeof I18nConfig>;
export type I18nConfigInput = z.input<typeof I18nConfig>;
