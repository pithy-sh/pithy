# @pithy-sh/i18n

Language for a Pithy app — negotiated per request, rendered through one seam. One piece of middleware. No tables, no migrations, no bindings, no error codes of its own.

It answers one question — *what language is this reader in?* — and hands every capability, every screen and every email a translator that already knows the answer.

## The seam is in core; this capability fills it

`c.var.t` is always there. Core seeds every request with a translator over the English each composed capability contributed, so a capability writes `c.var.t.t("auth/invalid_token")` with no null check and no config. `@pithy-sh/i18n` replaces that translator with one that negotiated the reader's locale and merged the catalogs behind it.

**A project that never composes it is byte-identical to one from before any of this landed.** Same strings, same bytes, no negotiation, no merge. That is the property the whole design is arranged around, and it is why the capability is optional rather than a dependency of core: `Translator` lives in `@pithy-sh/core/src/i18n/translator` and an adopter's own module can type against it whether or not they ever opt in.

```ts
// pithy.config.ts
i18n({
  supportedLocales: ["en", "es"],
  defaultLocale: "en",
});
```

```ts
// anywhere in a route
c.var.t.t("auth/sign_in.title");
c.var.t.plural("email/magic_link.expiry", 15);   // `count` is supplied for you
c.var.t.formatCurrency(1250, "EUR");
c.var.locale?.direction;         // "ltr" | "rtl", for `dir` on the document
```

## Two locales, and only one of them falls back

The reader's tag does two different jobs, and collapsing them is the bug where an Argentine reads Spanish and sees `1,234.56`.

| | What it is | Does it fall back? |
|---|---|---|
| `catalogLocale` | The locale whose catalog answers `t()` — the words somebody actually wrote. | **Yes.** An `es-AR` reader gets `es`, because `es` is what is written. |
| `formattingLocale` | The locale handed to `Intl`. | **No.** An `es-AR` reader gets `es-AR`, which `Intl` supports natively whether or not a translator ever did. |

So a reader in Buenos Aires gets Spanish sentences and Argentine dates, numbers and currency, from one translator, with nobody writing an `es-AR` catalog.

## How a locale is resolved

Two chains, because half of each side's links do not exist on the other. `localStorage` is absent from a Worker, and `navigator.language` inside workerd is the constant `"en"`.

**Server** — `param` → `user` → `cookie` → `header` → `default`. `?lang=es`, then the signed-in reader's `pithy_auth_users.locale`, then the locale cookie, then `Accept-Language`, then the project default.

**Browser** — `query` → `account` → `storage` → `server` → `default`.

Both orders are configuration. Reorder or shorten either, and `default` is the last resort whether or not it is listed.

`Accept-Language` is honored as the **whole q-weighted list**, not its first entry: `pt-PT;q=1.0, es;q=0.8, en;q=0.5` from a project with no Portuguese is a request for Spanish, and reading only the head answers English. A header full of `*`, `en_US` and empty tokens falls through to the default rather than throwing — every one of those makes `new Intl.Locale()` raise a `RangeError`, and a 500 on the request path is not a negotiation strategy.

**The account outranks the device.** `pithy_auth_users.locale` is where a person's locale lives, so a reader who picks Spanish on their phone is not reading French on their laptop because that laptop's `localStorage` holds an older choice. `?lang=` stays above both, and a signed-in reader's choice is written through to their account rather than only to storage — through the `persist` seam below, because the call that writes that column is `@pithy-sh/auth`'s and not this package's.

## The layer order

`t(key)` walks, **per key**:

1. the adopter's catalog for the resolved locale,
2. the adopter's catalog for the project default,
3. the kit's translation for the resolved locale,
4. every composed capability's English, for the resolved locale,
5. that same English for the project default.

Per key, never per catalog. Overriding one sentence is one entry, and every key you did not mention keeps flowing from the package. **That is what makes an override a merge rather than a fork.**

```ts
i18n({
  supportedLocales: ["en", "es"],
  messages: {
    es: { "auth/sign_in.title": "Entrar" },   // one sentence. Everything else stays ours.
  },
});
```

## The catalogs live in the package

The kit ships **Spanish** today. It ships no English catalog, and that is not an omission: English is the source. An error carries its English `message` on the wire, a capability contributes its English through `Capability.messages`, and a copied screen carries the English it was scaffolded with. A second copy would be a second place for one sentence to drift.

The translations are **never copied into your repository**. If the Spanish for `auth/sign_in.title` lived in your tree, a typo fix or a new locale could never reach you, and every adopter would become a fork on the day they scaffolded. Passing a whole locale object to `messages` **is** the fork — which is why no eject command is offered for this, and none is needed.

Server-side the catalogs are imported statically: they are text, they are small, and a Worker has no second round trip to spend. The browser reaches the same catalogs by dynamic import, one chunk per locale.

## Errors are never localized by the server

`ErrorPayload.message` stays English, permanently. It is simultaneously the operator's diagnostic and the fallback for every client that does not translate, so a server that translated it would break both. The payload carries an optional `params` beside it, and a translating client renders:

```ts
t.maybe(payload.code, payload.params) ?? payload.message;
```

For an error **the key is the code**. `auth/invalid_token` is a catalog key and an error code and the same string, so there is no second identifier to keep in sync and `KitErrorCode` is the exact checklist a locale has to cover.

## The React bindings are a first-class API

Not something the kit's own templates happen to import. Screens are *copied*, so after the first day most adopters are rendering their own, and the seam has to be consumable without ever touching a kit template.

```tsx
import { TranslatorProvider, useTranslator } from "@pithy-sh/i18n/src/react/translator";

// At the root of a page.
<TranslatorProvider value={{ catalogLocale, formattingLocale, layers }}>{children}</TranslatorProvider>;

// In any screen. `EN` is the English it was scaffolded with.
const t = useTranslator(EN);
```

`useTranslator` **never throws for want of a provider.** With none, it is exactly a translator over the fallback — no negotiation, no merge, no config, which is what a copied screen does in a project that never composed this capability. With a provider, the fallback goes **last**: the adopter's catalog, then the kit's translation, then the screen's own English. A key nobody has renders as the key, because a blank reads like finished copy and would ship.

`useNegotiatedLocale` (`@pithy-sh/i18n/src/react/useNegotiatedLocale`) runs the browser chain, loads the matching kit catalog by dynamic import, and keeps `<html lang>` and `dir` in step with it. It is the whole of the wiring for an app that renders none of the kit's screens.

**It takes what a browser holds.** `virtual:pithy/i18n` is locale metadata and nothing else — the languages, the chain order, the two names a page looks itself up by — so nothing asks your front end for the catalogs, the cookie name or the server chain that only a Worker has. Your own catalogs go in through `messages`, above the kit's.

```tsx
import { updateUser } from "@pithy-sh/auth/src/client/api";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";
import { useNegotiatedLocale } from "@pithy-sh/i18n/src/react/useNegotiatedLocale";
import i18nConfig from "virtual:pithy/i18n";

const OURS = { es: { "board/nav.settings": "Ajustes" } };

export function Shell({ children }: { children: ReactNode }) {
  const { source } = useNegotiatedLocale(i18nConfig, {
    // Your own catalogs. They sit above the kit's translation, so one entry overrides one sentence.
    messages: OURS,
    // The signed-in reader's stored locale, when you know it. It outranks this device's memory.
    account: session?.user.locale,
    // Called when a reader picks a language, so the choice follows them to their next device.
    persist: (next) => {
      void updateUser({ locale: next });
    },
  });
  // `source` is null only until this locale's catalog lands — a few milliseconds, during which every
  // screen renders the English it was scaffolded with. It is also the one line that handles a project
  // with no `i18n` composed at all: the projection says so, nothing is negotiated, no chunk is
  // downloaded, and every screen keeps its baked English permanently.
  if (!source) return children;
  return <TranslatorProvider value={source}>{children}</TranslatorProvider>;
}
```

**`persist` is the half that keeps one home.** `account` outranks `storage` in the chain precisely so a reader who picks Spanish on their phone is not reading French on their laptop — and without a write-through, that ordering describes a value nothing updates. This package cannot do it for you: `pithy_auth_users.locale` is written through `updateUser` (`@pithy-sh/auth/src/client/api`), which is a call `@pithy-sh/auth` owns and this package never imports. It is called and not awaited, and a rejection is caught rather than reported, so a failed preference write never costs the reader the language they just picked.

**The `void` above is the discard, and it earns its keep.** `persist` returns `void | Promise<void>` while `updateUser` resolves to an `AuthResult`, so returning the call straight does not typecheck; the explicit discard is the form that does. Nothing is lost by dropping it: `updateUser` never throws — every refusal, a signed-out reader's included, is a value it hands back — so there is no rejection here for the hook's `catch` to have caught anyway. If a dropped write is worth knowing about, `await` it inside the callback and read `result.ok` there, where you know what your app should say.

## Already running an i18n stack?

Adapt it rather than migrate it. `fromI18next`, `fromIntl` and `fromLingui` (`@pithy-sh/i18n/src/adapters/adapters`) each take the instance you already constructed and hand back a `Translator`.

**None of those libraries is a dependency here, and none can become one.** Each adapter duck-types three or four members declared as a structural type, so nothing is imported and nothing is installed. A version of i18next that moves a method is a compile error in your repository rather than a broken dependency in ours. The words come from your library; the formatting always comes from `Intl` — every one of them formats through `Intl` anyway, workerd embeds full ICU, and a translator that delegated formatting would answer a different date for the same locale depending on which adapter was in use.

### i18next

```tsx
import { fromI18next } from "@pithy-sh/i18n/src/adapters/adapters";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";
import i18n from "i18next";

// Your instance, configured however you already configure it.
await i18n.init({ lng: "es", resources: { es: { translation: { "app/greeting": "Hola." } } } });

export function App({ children }: { children: ReactNode }) {
  // The second argument is the formatting locale, for when it is more specific than the catalog's.
  return <TranslatorProvider value={fromI18next(i18n, "es-AR")}>{children}</TranslatorProvider>;
}
```

i18next selects plurals from a `count` option rather than a key suffix, so the adapter hands it `count` and lets it choose. The kit's `<key>.<category>` convention is not imposed on a catalog i18next already owns.

### FormatJS / react-intl

```tsx
import { fromIntl } from "@pithy-sh/i18n/src/adapters/adapters";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";
import { useIntl } from "react-intl";

export function PithyBridge({ children }: { children: ReactNode }) {
  const intl = useIntl();
  return <TranslatorProvider value={fromIntl(intl)}>{children}</TranslatorProvider>;
}
```

Mount it inside your own `IntlProvider`. FormatJS resolves plurals inside the ICU message, so `plural` passes `count` as a value and the message's own `{count, plural, …}` arm decides.

### Lingui

```tsx
import { i18n } from "@lingui/core";
import { fromLingui } from "@pithy-sh/i18n/src/adapters/adapters";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";

export function PithyBridge({ children }: { children: ReactNode }) {
  return <TranslatorProvider value={fromLingui(i18n)}>{children}</TranslatorProvider>;
}
```

The same shape as FormatJS — the two differ only in what the lookup is called.

### On the server

The middleware puts a translator on `c.var.t`. To use your own instead, set one in a middleware of your own: nothing null-checks `c.var.t`, so replacing it is the whole of it.

```ts
app.use("*", async (c, next) => {
  c.set("t", fromI18next(i18nFor(c.req.header("accept-language"))));
  await next();
});
```

### Anything else

`Translator` is an interface, so a library with no adapter here does not need one written here. Write the object.

```ts
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { createTranslator } from "@pithy-sh/core/src/i18n/translator";

export function fromYourLibrary(lib: YourLibrary, formattingLocale?: string): Translator {
  // Start from a translator with no catalogs: it brings every `Intl` helper, already wired correctly.
  const base = createTranslator({ catalogLocale: lib.locale, formattingLocale, layers: [] });
  const translate = (key: string, params?: Record<string, string | number | boolean>) => lib.lookup(key, params);
  return {
    ...base,
    t: translate,
    // `maybe` is the one to get right: `null` on a miss is what makes `t.maybe(code, params) ?? message`
    // fall back to the English an error already carries. Most libraries answer the key on a miss.
    maybe: (key, params) => {
      const answered = translate(key, params);
      return answered === key ? null : answered;
    },
    plural: (key, count, params) => lib.plural(key, count, params),
  };
}
```

Spread `createTranslator`'s result and override only the lookups. The eight formatting members are already right, and delegating those to a wrapped library is how two locales start disagreeing about the same date.

**Whatever you mount, the screens keep their own English behind it.** `useTranslator(EN)` layers a screen's baked catalog *under* the provider, so a key your library has no word for still renders the sentence Pithy scaffolded rather than a raw key. Plugging your stack in never costs you the copy the kit already wrote.

## Coverage is a `pithy doctor` check

Not a `pithy i18n check` command. For every locale you serve, every key reachable in the default locale must be reachable in that one too — through your catalog, the kit's translation, or a capability's own. A gap is a local finding, it names the locale and the missing keys, and it fails `doctor`'s exit code.

```
i18n.supportedLocales.fr
  3 messages have no `fr` translation, so a reader in that language meets en instead.
  Add them to `i18n({ messages: { fr: … } })` in your `pithy.config.ts`: app/greeting, app/nav.settings, app/sign_out.
```

There is no account tier. Nothing about language is a question for the Cloudflare API.

## What it costs you

Nothing durable. No table, no migration, no `migrationOrder` to allocate, no binding in `wrangler.jsonc`, no reserved error domain — an adopter is free to declare `i18n/missing_catalog` of their own through `defineErrorPayload`. Adding it is one line in `pithy.config.ts`; removing it puts every reader back on the baked English, byte for byte.

---

See [docs/I18N.md](../../docs/I18N.md) for the full guide — the key grammar, the exception map, writing a locale, and how catalogs reach the browser.
