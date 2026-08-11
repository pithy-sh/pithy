---
"@pithy-sh/email": minor
---

A delivered job stops holding the link it mailed.

`enqueueEmail` wrote the caller's payload into `pithy_email_jobs` verbatim and nothing in the capability ever deleted a job row, so every link ever mailed stayed in plaintext for the life of the table. For a newsletter that is a send log. For a magic link the payload *is* the sign-in link, for an OTP it is the code, and for an invitation it is the token — a second, permanent copy of a live credential in a table nobody thinks of as holding secrets. An adopter storing invitation tokens as digests then mailed the plaintext into this table, and the digest bought nothing.

A delivered job's payload is now emptied and stamped with `payloadRedactedAt`, in the same write that marks it `sent`.

**"Spent" means after the last attempt this job will ever make, not after the first.** `sent` is the only status that qualifies — and it qualifies because a retry is already refused for it, a delivered job being a duplicate email to a real person. Every other outcome keeps its inputs on purpose: a `failed` job is what `POST /email/jobs/:id/retry` exists for and it re-renders from the payload, and a `suppressed` job never sent anything and its block can be lifted. A payload dropped too early is a message that cannot be resent, which is a worse failure than the one being fixed.

**It is the default for transactional templates, keyed on the category rather than the kind.** The kind answers "may this be refused"; this question is "are these inputs a one-time credential". `testerNudge` proves they are different axes: it is elective, and its CTA is an opt-in URL that authenticates a tester — keying on the kind would have left exactly that one live. `newsletter` and `marketingCampaign` keep their payloads, which are copy authored for a batch rather than anyone's credential.

What an operator needs is untouched: was this sent (`status`, `sentAt`, the `sent` event), to whom (`toAddress`), what it was (`template`, the rendered `subject`), and whether it arrived (`messageId` and the bounce/open/click events). Nothing changes at the management routes, where the payload was never projected.

`pithy_email_jobs` gains a nullable `payloadRedactedAt` column.
