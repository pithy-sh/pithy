---
"@pithy-sh/auth": minor
---

Better Auth's refusals speak the reader's language.

Every sentence a Pithy screen renders went through the translator seam except the ones Better Auth raised. Those arrived in English, from its own vocabulary, on a screen that was otherwise entirely in Spanish — and they are met by the most ordinary mistake there is. A reader who mistyped their one-time code was reading `Invalid OTP`.

**Translated at the server, which is the one place these can be translated at all.** `docs/I18N.md` holds that a `PithyError`'s `message` stays English permanently, because it is at once the operator's diagnostic and the fallback for a client that cannot translate. These are not `PithyError`s: Better Auth owns those routes and answers them in its own flat `{ message, code }` before anything of ours sees the failure, so there is no payload for a client to key on. `@better-auth/i18n` (MIT) substitutes the message and keeps the English on `originalMessage`, so nothing is taken from whoever reads a log. It also reaches a caller the client seam cannot — a mobile app holding a bearer token gets the reader's language without shipping `@pithy-sh/i18n`.

**One negotiation, not two.** The locale is `c.var.locale`, resolved by the project's own configured chain before the instance was built. The plugin's `header`, `cookie` and `session` strategies are deliberately unused: two chains over one page is the bug where a reader who chose Spanish with `?lang=es` gets Spanish screens and English errors. A project that never composes `i18n` negotiates nothing and reads byte for byte what it read before.

**The words are layered, never copied.** The plugin ships 22 languages, maintained upstream; this kit writes only what they are missing. That turned out to matter: of the 52 codes the composed plugin set can raise, their `es` covered 34 — and the 18 it missed included every one of `emailOTP`'s. `INVALID_OTP`, `OTP_EXPIRED` and `TOO_MANY_ATTEMPTS` are the whole vocabulary of a passwordless sign-in going wrong, which is to say the only ones most readers will ever see.

**And a gate, because the property is only true as a set.** Every code the composition can raise must be translated or named in `ENGLISH_ON_PURPOSE` with the reason it stays English — those are adopter misconfigurations, where an English sentence is easier to search for and no harder to fix. A code Better Auth adds in a later release fails the build instead of quietly reaching somebody in English.
