---
"@pithy-sh/email": minor
"@pithy-sh/testers": patch
---

An unsubscribe no longer disables passwordless sign-in.

The suppression list is keyed by address and holds no memory of which message somebody was refusing, and the send path blocked on any row whatever its reason. So one opt-out from a weekly digest — entirely legitimate — also withheld that person's magic link. Passwordless is the kit's sign-in and there is no password to fall back on, so the account became permanently unreachable, and nothing said so: the send was *skipped*, not failed, so the caller saw success and the person saw an empty inbox.

Two doors, and closing one was never enough. **A template now declares its kind** — `transactional` or `elective` — and the kind decides everything downstream. It is not an argument a caller passes, because a caller can get it wrong and the failure is an account nobody can reach; templates are this capability's own, so `magicLink` and `otp` are transactional by declaration and no call site can send them any other way. There is no default: a forgotten kind is a type error.

Transactional mail carries no unsubscribe affordance and no `List-Unsubscribe` header. That header is not extra safety on a login message — it publishes a mechanism for disabling authentication, one tap from the mail the account depends on, and some clients surface it as prominently as the body. Elective mail carries both, with RFC 8058 one-click; the unsubscribe callback answers a POST so the header is honest rather than decorative.

And the suppression check now consults the reason. A hard bounce or a complaint blocks everything — the mailbox is dead, or the domain's reputation is at stake, and neither is softened by the message being one somebody is waiting for. An operator's `manual` block still stops everything, because narrowing it would overrule the person who set it. An unsubscribe blocks elective mail only. `SendOutcome` gained `suppressionReason`, and the job row and event carry it, so a skipped send is reported rather than swallowed.

`isSuppressed` is replaced by `blockingSuppression(db, email, now, kind)`, which returns the reason that blocked or `null`. The kind is required rather than defaulted: the default that reads as safe is the one that locks people out.
