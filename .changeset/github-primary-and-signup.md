---
"@pithy-sh/auth": minor
"@pithy-sh/ui-react": minor
"@pithy-sh/i18n": patch
---

GitHub sign-in no longer mints a second, empty account.

A GitHub account whose primary address is not the one you signed up with matched nothing here, and signing in created a fresh user beside your real one. That is most people's GitHub — a personal primary with the work address secondary — and there was no way to say "GitHub may sign people in, but not create accounts."

`allowSignUp` is now per provider, so a project can let email create accounts while GitHub only signs existing ones in. A GitHub sign-in matching no account refuses and mints nothing, and the sign-in screen explains why in three sentences: what GitHub told us, that a secondary address will not do it, and the remedy. A bare refusal would send somebody to verify an address that is already correct.

The resolution rule is the kit's now, and yours to replace with `auth({ resolveGithubUserInfo })`. It reads the primary and only the primary, reports GitHub's own per-address verified flag rather than asserting one, and fails closed when GitHub does not answer — so an outage reads as an outage instead of "your account does not exist."

A provider is also no longer the last way in. Magic link is unconditional here, so unlinking the only connected provider is allowed — which is what makes an account stranded by the old behavior recoverable without a merge rule: sign in to it by email, disconnect GitHub, then connect it where it belongs.

Connecting a GitHub whose primary differs from your account's address is still refused, deliberately, and `docs/github-oauth.md` says what that is waiting on.
