---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/i18n": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
---

`zod`, `kysely` and `hono` are peer dependencies now, so you and the kit share one copy.

They were plain dependencies, which meant an adopter who imports them directly — and anyone writing their own schemas or queries does — could end up with a second copy. Two copies of a package whose classes carry private members are two different types, and the compiler says so in a way that names neither the package nor the duplication:

```
Type 'Kysely<any>' is not assignable to type 'Kysely<any>'.
  Property '#private' refers to a different member that cannot be accessed from within type.
```

Both paths read identically unless you compare them character by character. A dependency is the kit saying "I need some copy of this"; a peer dependency is the kit saying "you and I must share one", which is the true statement and the one npm, pnpm and bun all act on by installing it once, at the top, where your own import finds it too.

**Nothing to do in most projects.** Your installer resolves the peer on the next install. If you already declare these, check the range matches — `zod@^4.4.0`, `kysely@^0.29.0`, `hono@^4.13.2`.

`@hono/zod-validator` and `kysely-d1` are deliberately not peers: their types do not cross the published boundary, and each depends on `hono` and `kysely` itself, so the copy that matters is already the shared one.

**`pithy doctor` reports a duplicate now**, with the directories each copy was resolved from, because the symptom is otherwise unreadable. It resolves rather than scanning, so what it answers is whether the kit and your code agree on which copy — and it never fails the exit, since a second copy can be deliberate.
