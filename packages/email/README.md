# @pithy-sh/email

D1-backed email for Cloudflare. Every send is a durable job: scheduled, retried, tracked.

Themeable templates, click, open and unsubscribe tracking, and bounce-driven suppression. No mail is ever sent inline.

```sh
pithy add email
```

**Documentation: [pithy.sh/docs/capabilities/email](https://pithy.sh/docs/capabilities/email).** Overview, adding it, using it, and the reference: the job model, send modes, templates.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Consent

Email declares two consent purposes: `email.marketing` and `email.tracking`. With [`@pithy-sh/consent`](../consent/README.md) composed, a `marketing` template is sent only to a subject consenting to marketing, and opens and clicks are tracked only for one consenting to tracking. Pass the subject as `consentSubject` when you enqueue. A message with no subject is withheld if marketing and untracked either way. Transactional mail is never gated. A withdrawal from marketing suppresses the address for elective mail, permanently, so it also holds mail already scheduled; granting marketing again lifts that suppression and no other, so a bounce, a complaint or an unsubscribe link stands. A withdrawal from tracking stops tracking mail already queued. Without consent composed, email behaves as it always has, and `pithy doctor` says tracking runs with no consent record behind it.

## A person's data

**Retained.** When an account is purged, email erases nothing: *Kept so your unsubscribe holds: the address stays on the list of addresses not to mail, with the record of what was sent to it.* The purge records the step as retained with that basis, and an export hands back the address's suppression and its mail log — never a message's variables or a tracked link. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
