---
"@pithy-sh/i18n": minor
"@pithy-sh/ui-react": patch
---

`useNegotiatedLocale` takes the object a browser actually holds.

It took `I18nConfig` — the **server-side** config, carrying the catalogs, the cookie name and the server resolver chain. A browser holds `virtual:pithy/i18n`'s projection, which has none of those, and whose `browserResolvers` is `string[]` rather than the resolver enum. `packages/i18n/README.md` showed the projection being passed anyway, and that line did not typecheck.

It takes `I18nClientProjection` now, which is what the hook already read: `queryParam`, `storageKey`, `browserResolvers`, `supportedLocales`, `exceptions`, `defaultLocale`. Nothing is lost — `messages` was always an option rather than read off the config — and the five lines every adopter wrote to widen one into the other are gone.

`{ enabled: false }` is a real branch rather than a cast: a project that never composed `i18n` renders the English it was scaffolded with, which is what makes the capability optional.

**This changes an exported signature.** `resolveBrowserLocale`, `resolveChain` and `readBrowserSignals` move with it. Nothing is published yet, so this lands as a minor rather than a major; the day a version is cut, a change of this shape is a breaking one.
