---
"@pithy-sh/auth": minor
"@pithy-sh/ui-react": minor
"@pithy-sh/i18n": patch
---

The sign-in screen stops promising an account a provider will refuse.

With email sign-up on and `github: { allowSignUp: false }` — the configuration per-provider sign-up exists for — the screen said "Signing in creates one." directly beneath a GitHub button that would refuse. True of the link, false of the button, and the reader found out after a full round trip to GitHub.

Each provider's sign-up policy now reaches the browser, so the sentence can say which half it means. Nothing changes for a project where everything may sign up.

A copied screen predating the field reads it as absent, which means "no provider refuses" — what every project's behavior was until now.
