// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { I18nConfig, type I18nConfigInput } from "../config/config";
import { i18nMiddleware } from "./middleware";

/**
 * The middleware, inside Miniflare, against real `Request` objects.
 *
 * The runtime matters here in a way it does not for the resolvers. A `Request` in workerd carries the
 * header casing, the cookie jar and the URL parsing a deployed Worker sees, and — the reason this file
 * exists rather than a node test with a hand-built context — **the isolate really is reused between
 * requests**. Every other property below could be checked in node. The one that cannot is the one that
 * the per-request translator exists to hold.
 */

const EN: MessageCatalog = { "app/greeting": "Hello." };
const ES: MessageCatalog = { "app/greeting": "Hola." };
/** Arabic, so `direction` has something to be other than `ltr`. */
const AR: MessageCatalog = { "app/greeting": "\u0645\u0631\u062d\u0628\u064b\u0627." };

/** The catalogs a composed project would have merged, keyed by locale. */
const CATALOGS: Record<string, MessageCatalog> = { en: EN, es: ES, ar: AR };

/**
 * The layer walk the capability supplies: this locale's catalog, then the default locale's.
 *
 * Stated here rather than imported from `capability.ts` so a failure names the middleware. The
 * capability's own five-layer order is pinned in `src/capability.test.ts`.
 */
const layersFor = (locale: string): readonly (MessageCatalog | undefined)[] => [CATALOGS[locale], EN];

const config = (input: I18nConfigInput = {}): I18nConfig =>
  I18nConfig.parse({ supportedLocales: ["en", "es", "ar"], defaultLocale: "en", ...input });

/** What each request reports back, so one route answers every question these cases ask. */
interface Answer {
  /** The rendered message — the whole point of the seam. */
  greeting: string;
  /** The locale whose catalog answered. */
  catalogLocale: string | null;
  /** The locale handed to `Intl`. */
  formattingLocale: string | null;
  /** A number formatted through the request's own translator, so the two locales are told apart. */
  number: string;
  /** Which way the page lays out. The half a suite that only reads sentences cannot see. */
  direction: string | null;
}

/**
 * One app, mounted the way `createBackend` mounts a capability's middleware.
 *
 * Returned rather than built per request on purpose: several cases below hold the same instance across
 * two requests, which is the only place isolate reuse is observable.
 */
function mount(resolved: I18nConfig = config()): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  i18nMiddleware(resolved, layersFor)(app);
  app.get("/", (c) =>
    c.json<Answer>({
      greeting: c.var.t.t("app/greeting"),
      catalogLocale: c.var.locale?.catalogLocale ?? null,
      formattingLocale: c.var.locale?.formattingLocale ?? null,
      number: c.var.t.formatNumber(1234.56),
      direction: c.var.locale?.direction ?? null,
    }),
  );
  return app;
}

/**
 * The same app, with a middleware ahead of this one that has already put the reader's row on the
 * request — what a Worker composing `@pithy-sh/auth` looks like by the time the locale is resolved.
 *
 * Registered before `i18nMiddleware`, because Hono runs `use` handlers in declaration order and the
 * `user` link reads a value that must already be there.
 */
/**
 * The i18n middleware mounted **behind** a stand-in for `@pithy-sh/auth`'s session middleware.
 *
 * `stored` is what `pithy_auth_users.locale` holds for the signed-in reader, published on
 * `c.var.auth` exactly as auth publishes it. This used to write `c.var.locale` instead, which is what
 * the `user` link read at first and what nothing in the tree ever wrote — so the link contributed
 * nothing, the chain silently degraded to `param → cookie → header → default`, and this test passed
 * against a feature that did not work.
 *
 * `mountAheadOfAuth` below mounts the two the other way round on purpose: the answer must not depend
 * on which capability an adopter happened to list first in `pithy.config.ts`.
 */
function mountBehindAuth(stored: string | null, resolved: I18nConfig = config()): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (stored !== null) {
      c.set("auth", { userId: "u1", sessionId: "s1", scopes: [], locale: stored });
    }
    await next();
  });
  i18nMiddleware(resolved, layersFor)(app);
  app.get("/", (c) =>
    c.json<Answer>({
      greeting: c.var.t.t("app/greeting"),
      catalogLocale: c.var.locale?.catalogLocale ?? null,
      formattingLocale: c.var.locale?.formattingLocale ?? null,
      number: c.var.t.formatNumber(1234.56),
      direction: c.var.locale?.direction ?? null,
    }),
  );
  return app;
}

/** The same two, mounted in the other order — i18n first, then auth. The answer must not change. */
function mountAheadOfAuth(stored: string | null, resolved: I18nConfig = config()): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  i18nMiddleware(resolved, layersFor)(app);
  app.use("*", async (c, next) => {
    if (stored !== null) {
      c.set("auth", { userId: "u1", sessionId: "s1", scopes: [], locale: stored });
    }
    await next();
  });
  app.get("/", (c) =>
    c.json<Answer>({
      greeting: c.var.t.t("app/greeting"),
      catalogLocale: c.var.locale?.catalogLocale ?? null,
      formattingLocale: c.var.locale?.formattingLocale ?? null,
      number: c.var.t.formatNumber(1234.56),
      direction: c.var.locale?.direction ?? null,
    }),
  );
  return app;
}

/** A request through `app`, with the given headers, answered as the JSON the route renders. */
async function ask(app: Hono<PithyHonoEnv>, path: string, headers: Record<string, string> = {}) {
  const response = await app.request(new Request(`https://example.test${path}`, { headers }));
  return { status: response.status, body: (await response.json()) as Answer };
}

describe("the request's locale, negotiated in the runtime", () => {
  test("`Accept-Language: es` gets a Spanish-answering `c.var.t`", async () => {
    const { status, body } = await ask(mount(), "/", { "accept-language": "es" });
    expect(status).toBe(200);
    expect(body.greeting).toBe("Hola.");
    expect(body.catalogLocale).toBe("es");
  });

  test("no signals at all is the project default", async () => {
    const { body } = await ask(mount(), "/");
    expect(body.greeting).toBe("Hello.");
    expect(body.catalogLocale).toBe("en");
  });

  test("`?lang=` beats the header", async () => {
    const { body } = await ask(mount(), "/?lang=es", { "accept-language": "en" });
    expect(body.greeting).toBe("Hola.");
    expect(body.catalogLocale).toBe("es");
  });

  test("and beats it in the other direction, so it is the param answering rather than Spanish winning", async () => {
    const { body } = await ask(mount(), "/?lang=en", { "accept-language": "es" });
    expect(body.greeting).toBe("Hello.");
    expect(body.catalogLocale).toBe("en");
  });

  test("the cookie is read", async () => {
    const { body } = await ask(mount(), "/", { cookie: "pithy_locale=es" });
    expect(body.greeting).toBe("Hola.");
    expect(body.catalogLocale).toBe("es");
  });

  test("the cookie name is the configured one, not a literal", async () => {
    const renamed = config({ cookie: "lang_pref" });
    expect((await ask(mount(renamed), "/", { cookie: "lang_pref=es" })).body.catalogLocale).toBe("es");
    expect((await ask(mount(renamed), "/", { cookie: "pithy_locale=es" })).body.catalogLocale).toBe("en");
  });

  test("the query parameter name is the configured one too", async () => {
    const renamed = config({ queryParam: "hl" });
    expect((await ask(mount(renamed), "/?hl=es")).body.catalogLocale).toBe("es");
    expect((await ask(mount(renamed), "/?lang=es")).body.catalogLocale).toBe("en");
  });

  test("the cookie is only consulted when the param is silent", async () => {
    const { body } = await ask(mount(), "/?lang=en", { cookie: "pithy_locale=es" });
    expect(body.catalogLocale).toBe("en");
  });

  test("an `es-AR` reader reads the `es` catalog and formats as `es-AR`", async () => {
    const { body } = await ask(mount(), "/", { "accept-language": "es-AR,es;q=0.9" });
    expect(body.greeting).toBe("Hola.");
    expect(body.catalogLocale).toBe("es");
    expect(body.formattingLocale).toBe("es-AR");
    // The half that would be lost if the two locales were ever collapsed: Spanish words, Argentine digits.
    expect(body.number).toBe("1.234,56");
  });

  test("an English reader gets English digits from the same route", async () => {
    const { body } = await ask(mount(), "/", { "accept-language": "en-US" });
    expect(body.number).toBe("1,234.56");
  });
});

describe("the signed-in reader's own locale", () => {
  /**
   * The `user` link, which had no test until #441's verification pass — replacing the whole read with
   * `null` passed all 130 tests in this package.
   *
   * It is the link that makes `pithy_auth_users.locale` the one home for a person's language. Without
   * it a reader who chose Spanish on their account meets `Accept-Language` on every request, and the
   * column they wrote is read by nothing.
   */
  test("a locale already on the request outranks the header", async () => {
    const { body } = await ask(mountBehindAuth("es"), "/", { "accept-language": "en" });
    expect(body.greeting).toBe("Hola.");
    expect(body.catalogLocale).toBe("es");
  });

  test("but `?lang=` still outranks it — switching language on one page is this page, right now", async () => {
    const { body } = await ask(mountBehindAuth("es"), "/?lang=en");
    expect(body.catalogLocale).toBe("en");
  });

  test("and the cookie behind it does not, so the order is param, user, cookie", async () => {
    const { body } = await ask(mountBehindAuth("es"), "/", { cookie: "pithy_locale=en" });
    expect(body.catalogLocale).toBe("es");
  });

  test("with no row loaded, the header answers as it always did", async () => {
    // The anti-vacuity half: without it, a `user` link hardcoded to `"es"` would pass every case above.
    const { body } = await ask(mountBehindAuth(null), "/", { "accept-language": "es" });
    expect(body.catalogLocale).toBe("es");
    expect((await ask(mountBehindAuth(null), "/")).body.catalogLocale).toBe("en");
  });

  test("a stored locale this project does not serve falls through rather than being served", async () => {
    // A row written when the project served more languages than it does today.
    const { body } = await ask(mountBehindAuth("de"), "/", { "accept-language": "es" });
    expect(body.catalogLocale).toBe("es");
  });

  test("this middleware replaces `c.var.locale`, it does not merge into it", async () => {
    // The `user` link reads the previous value as one more *candidate*, never as the decision. A
    // middleware that left the auth row's `LocaleContext` in place would serve the right words with
    // the wrong `formattingLocale` the moment a reader sent `?lang=`.
    const { body } = await ask(mountBehindAuth("es"), "/?lang=en");
    expect(body.formattingLocale).toBe("en");
  });
});

describe("which way the page lays out", () => {
  test("a right-to-left reader gets `rtl` on `c.var.locale`", async () => {
    // `dir` on the document is the one thing no catalog can supply, and an Arabic reader served `ltr`
    // reads a page laid out backwards while every assertion about the words still passes.
    const { body } = await ask(mount(), "/?lang=ar");
    expect(body.catalogLocale).toBe("ar");
    expect(body.direction).toBe("rtl");
  });

  test("a left-to-right reader gets `ltr`", async () => {
    expect((await ask(mount(), "/?lang=es")).body.direction).toBe("ltr");
    expect((await ask(mount(), "/")).body.direction).toBe("ltr");
  });

  test("it follows the catalog locale even when the region is elsewhere", async () => {
    const { body } = await ask(mount(), "/", { "accept-language": "ar-EG,ar;q=0.9" });
    expect(body.catalogLocale).toBe("ar");
    expect(body.formattingLocale).toBe("ar-EG");
    expect(body.direction).toBe("rtl");
  });
});

describe("the isolate is reused and the locale is not", () => {
  test("two sequential requests through the SAME app do not leak locale between them", async () => {
    // **The property this whole middleware is shaped around.** A Worker isolate serves requests from
    // different readers back to back, so a translator held anywhere but on the request — a module-level
    // cache, a memoized formatter keyed on nothing, a `z.config()`-shaped global — answers the second
    // reader in the first reader's language. Nothing in a single-request test can see it, and in
    // production it is a bug that only appears under load and never reproduces locally.
    const app = mount();

    const spanish = await ask(app, "/", { "accept-language": "es" });
    expect(spanish.body.greeting).toBe("Hola.");
    expect(spanish.body.catalogLocale).toBe("es");

    const stranger = await ask(app, "/");
    expect(stranger.body.greeting).toBe("Hello.");
    expect(stranger.body.catalogLocale).toBe("en");
    expect(stranger.body.number).toBe("1,234.56");
  });

  test("it holds across many alternating requests, not just the second one", async () => {
    const app = mount();
    for (let round = 0; round < 5; round += 1) {
      expect((await ask(app, "/", { "accept-language": "es" })).body.greeting).toBe("Hola.");
      expect((await ask(app, "/", { "accept-language": "en" })).body.greeting).toBe("Hello.");
    }
  });

  test("two apps built from one config do not share a translator either", async () => {
    const resolved = config();
    const first = mount(resolved);
    const second = mount(resolved);
    expect((await ask(first, "/", { "accept-language": "es" })).body.catalogLocale).toBe("es");
    expect((await ask(second, "/")).body.catalogLocale).toBe("en");
  });
});

describe("untrusted input reaches nothing", () => {
  test("a malformed `Accept-Language` is a 200 in the default locale, not a 500", async () => {
    // Every one of these throws a `RangeError` out of `new Intl.Locale()`. Unguarded, that is a 500 on
    // the request path for a header the reader's browser sent without being asked.
    for (const header of ["en_US", "en_US, de_DE", ";q=0.9", ", , ,", "-", "x".repeat(5000)]) {
      const { status, body } = await ask(mount(), "/", { "accept-language": header });
      expect(status, header).toBe(200);
      expect(body.catalogLocale, header).toBe("en");
      expect(body.greeting, header).toBe("Hello.");
    }
  });

  test("a hostile `?lang=` gets the default locale and nothing else", async () => {
    // The query string is read off the URL rather than through `zValidator`, because a global
    // middleware has no route line to declare one on. What replaces the validator is structural: the
    // value is matched against `supportedLocales` before anything is done with it, so nothing
    // downstream ever sees a string this project did not already configure.
    const hostile = ["%3Cscript%3E", "../../etc/passwd", "es'%20OR%201=1", "e".repeat(500)];
    for (const value of hostile) {
      const { status, body } = await ask(mount(), `/?lang=${value}`);
      expect(status, value).toBe(200);
      expect(body.catalogLocale, value).toBe("en");
      expect(body.formattingLocale, value).toBe("en");
    }
  });

  test("a garbage cookie value is skipped and the header behind it still answers", async () => {
    const { body } = await ask(mount(), "/", { cookie: "pithy_locale=en_US", "accept-language": "es" });
    expect(body.catalogLocale).toBe("es");
  });
});

describe("the answer does not depend on which capability was listed first", () => {
  /**
   * **The reason the resolution is lazy.**
   *
   * `createBackend` applies each capability's middleware in composition order — the order an adopter
   * happened to write in `pithy.config.ts`. Resolved eagerly, the `user` link reads `c.var.auth`
   * before `@pithy-sh/auth` has filled it whenever i18n is listed first, so the reader's stored
   * language is dropped for half of all projects with nothing failing to say so.
   *
   * Deferring to the first read of `c.var.t` makes both orders identical, because both middlewares are
   * `app.use("*")` and both have run before any handler. That is a property, not a convention.
   */
  test("auth first, then i18n — the stored locale wins over the header", async () => {
    const { body } = await ask(mountBehindAuth("es"), "/", { "accept-language": "en" });
    expect(body.catalogLocale).toBe("es");
    expect(body.greeting).toBe("Hola.");
  });

  test("i18n first, then auth — the same answer, which is the whole point", async () => {
    const { body } = await ask(mountAheadOfAuth("es"), "/", { "accept-language": "en" });
    expect(body.catalogLocale).toBe("es");
    expect(body.greeting).toBe("Hola.");
  });

  test("and `?lang=` outranks the account in either order", async () => {
    expect((await ask(mountBehindAuth("es"), "/?lang=en")).body.catalogLocale).toBe("en");
    expect((await ask(mountAheadOfAuth("es"), "/?lang=en")).body.catalogLocale).toBe("en");
  });

  test("with no reader signed in, both fall through to the header", async () => {
    const headers = { "accept-language": "es" };
    expect((await ask(mountBehindAuth(null), "/", headers)).body.catalogLocale).toBe("es");
    expect((await ask(mountAheadOfAuth(null), "/", headers)).body.catalogLocale).toBe("es");
  });
});
