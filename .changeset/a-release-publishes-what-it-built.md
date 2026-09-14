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
"@pithy-sh/organization": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
"@pithy-sh/vite": patch
---

A release now publishes what it built.

`release:local` never ran a build. It versioned the packages and published whatever `dist/` was lying in the checkout, so the 2026-09-14 release put twenty-two packages of weeks-old compiled code on npm under fresh version numbers — and `@pithy-sh/organization`, never built in that checkout at all, with no `dist/` and every deep import resolving to nothing.

This is those twenty-two, republished from a build. Nothing in the source changed; the artifact did.

The release builds now, after the bump and before the publish, and packs every tarball through the gate CI already ran. `packFaults` gains the one question a tarball can answer about how old its build is: the version compiled into `dist/version.generated.js` must be the version being published.
