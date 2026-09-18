---
"@pithy-sh/auth": patch
"@pithy-sh/i18n": patch
"@pithy-sh/ui-react": patch
---

Security: a refused social sign-in answered with a different code depending on whether an account existed at the address the provider asserted, so pressing a provider button and reading the `Location` header enumerated accounts — no page load, one GitHub account, none on the target.

`account_not_linked` was returned only when a user row matched the provider-resolved address and `signup_disabled` only when none did. GitHub will assert any address its holder has typed in, verified or not, so the question could be asked about anybody. It worked against `allowSignUp: false`, the configuration the kit's own guidance recommends, so the projects that followed the advice were the exposed ones.

**The refusal is now decided before Better Auth branches, so neither code is produced at all.** A kit plugin decorates `getUserInfo` on each provider object Better Auth has already built — wrapping it, never replacing it — and between that call and `handleOAuthUserInfo` there is nothing else. An identity already attached to an account signs in; an identity whose provider-**verified** address matches an account is linked and signed in; anything else is one refusal, the same one every time.

Wrapping rather than replacing is what keeps it honest. Each provider's own resolver still runs, so no profile fetch is reimplemented — and `mapProfileToUser` is applied inside it, so the wrapper reads the effective verified flag by construction. Facebook, whose address is asserted verified for a documented reason and whose OAuth payload carries no `email_verified` claim at all, needs no special case.

**Who gets in does not change.** Somebody who signed up with a magic link, presses Google — or GitHub, or Apple, or Facebook — and whose provider-verified address matches their account is linked and signed in on the first attempt, exactly as before. That is asserted per provider, driven end to end, with `allowSignUp` either way.

The reason for a refusal survives server-side: it reaches `pithy_audit_events` as its own outcome with the true cause, which no 302 ever carried, because a 302 is also what a completed sign-in answers with.

Also hardened on the way in: `errorCallbackURL` is normalized before Better Auth stores it — fragments, pre-existing `error` parameters and shapes that cannot be reasoned about are refused at the door — across both the body and the query, with one decoder mirroring `better-call`'s own and a gate that executes the real dependency rather than a model of it. A Better Auth plugin that surfaces callback refusals through a transport the capability cannot reach is refused at composition rather than silently uncovered.
