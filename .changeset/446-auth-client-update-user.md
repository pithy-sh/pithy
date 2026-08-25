---
"@pithy-sh/auth": minor
---

`updateUser` ships from the browser client.

`docs/I18N.md` states the rule — `pithy_auth_users.locale` is the one home for a person's language, so do not put language in your own preferences table — and `packages/i18n/README.md` documented the write-through as `persist: (next) => updateUser({ locale: next })`. There was no `updateUser`. An adopter following the guidance either stood up a second Better Auth client with `inferAdditionalFields`, duplicating configuration `@pithy-sh/auth` already owns, or spelled out `/update-user`, the content type and the guard one deep import below the surface every other auth call goes through.

It is built the way every call in that module is: through `callAuth`, same-origin checked, cookie mode, never throwing, no schema library in a browser bundle.

`locale` is the only kit user field declared `input: true`, because a reader's own preference is the opposite of a device id — and `null` is accepted, because taking a language choice back is an ordinary thing a reader does.
