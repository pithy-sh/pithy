---
"@pithy-sh/auth": minor
"@pithy-sh/core": minor
"@pithy-sh/i18n": patch
---

Connect a provider whose email differs from your account's.

A GitHub account whose primary address is not the one you signed up with could be signed in with but never attached. Signed in, you can now connect it: both sides are proven at that moment, and the address still has to be one the provider has verified.

Connecting requires a recent sign-in rather than merely a valid session. Attaching a provider grants permanent access — afterwards sign-in resolves by account id and the email stops mattering — so it is gated the way disconnecting one already is, and the refusal is recorded.

The window measures time since you authenticated, which is not the age of your session. Sessions carry a new `authenticated_at`, stamped at sign-in and carried forward verbatim by `/token/rotate`; a migration adds the column, and a session that predates it stays undated through every rotation, so it re-authenticates once and never fakes freshness. Gating on session age instead would have been reset by every ordinary refresh, and on demand by anyone holding a stolen refresh token.

Security: attaching a social provider now requires an authentication from the last fifteen minutes, measured so that a token rotation cannot reset it.
