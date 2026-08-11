---
"@pithy-sh/email": minor
---

An operational notice can be sent, and the closed registry is a decision on the record.

An app composing `email` could send a magic link, an OTP and a warning about a sign-in. It could not send *"a capability you run has a security release"* or *"a secret has not been rotated in ninety days"*. The nearest template was `securityAlert`, which is about a session and closes with "if this was you, no action is needed" — the opposite meaning.

`operationalNotice` is that shape: what happened, what it happened to, when, how serious, and one place to act on it. Facts are label/value rows, so a rotation, a release, an unreachable connection and a stuck job all fit one template — they differ in their words, and the words are payload.

**Severity is expressed, not flattened.** Each level owns a word — `Notice:`, `Action needed:`, `Critical:` — and that word leads the subject line, so the urgency is readable in an inbox list before anything is opened. It is repeated in the body and in the text part, and only then reinforced by colour. A design whose only difference between "a release is out" and "sign-in is broken" is a hex value teaches people to ignore both. There is no default severity: a caller who forgot the field would otherwise send an outage at the volume of a release note.

It renders with no link-signing key, because it is transactional and mints no token. An operational notice that cannot render is the notice you needed most.

**The registry stays closed, and the reasoning is now written down** in the package README. The Workers runtime forbids code generation, so a template cannot be compiled where it runs; an open registry could only accept a precompiled Handlebars spec built in the adopter's own build, and Handlebars refuses a spec whose compiler revision differs from the runtime's. Opening it would also make the message kind a claim a call site can assert again, and make escaping conventional rather than structural. What the closure obliges instead: a missing shape is a bug in the kit, and where the words are the adopter's, the template takes them as payload — `supportReply`, `testerNudge` and now `operationalNotice` are all that pattern.
