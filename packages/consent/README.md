# @pithy-sh/consent

Consent, recorded the way a regulator asks to see it. From a checkbox to a signed authorization with its exact document and expiry, for visitors and accounts alike, in your own D1.

```sh
pithy add consent
```

**Documentation: [pithy.sh/docs/capabilities/consent](https://pithy.sh/docs/capabilities/consent).** What compliance this answers is [`docs/COMPLIANCE.md`](../../docs/COMPLIANCE.md#consent).

## Purposes and versions

A purpose is what a person agrees to. A capability that processes under consent declares its own: `@pithy-sh/email` declares `email.marketing` and `email.tracking`. You add yours in `pithy.config.ts`, under your own domain:

```ts
consent({
  purposes: [
    {
      id: "clinic.records",
      summary: "Keep my health record so my care team can read it.",
      noticeVersion: 1,
      classes: ["phi"],
      explicit: true,
      minimumMethod: "typed",
      writtenWithdrawal: true,
    },
  ],
});
```

- **`noticeVersion`** is the notice in force. Bump it when the notice changes: every grant under an older version answers no until the person agrees again.
- **`classes`** are the data classes the purpose covers. The processing record reads them.
- **`explicit`** marks a GDPR Article 9 purpose.
- **`minimumMethod`** is the weakest method a grant may be given by, weakest first: `click`, `typed`, `drawn`, `provider`. A grant below it is refused.
- **`writtenWithdrawal`** requires a withdrawal at least at the grade of the grant it withdraws, as a HIPAA revocation must be in writing. Off, a click withdraws anything. Withdrawing is then never harder than granting.

A purpose is declared once. One under a composed capability's domain is refused at startup.

## The record

Every grant and every withdrawal is one row of `pithy_consent_records`: who, which purpose, which notice version, granted or withdrawn, when, by what method, and on which surface. **The database refuses to change it.** Triggers abort an update of any fact and every delete, so the record is append-only by schema rather than by promise. The one write allowed is the field-key rotator re-sealing an encrypted name. Every row is also an audit event, so `@pithy-sh/audit`'s chain makes the record tamper-evident.

A signed grant carries its evidence:

- **The document.** The SHA-256 of the exact text the person saw. Behind a signature, the text is kept once per hash in `pithy_consent_documents`, and produced again byte for byte. A click records the hash and keeps no text.
- **The method.** A typed name. A drawn signature, stored in the `CONSENT_EVIDENCE` R2 bucket under its own hash. Or a provider, its envelope id and its completion certificate, which your integration supplies. No provider SDK ships here.
- **Identity.** How the signer was verified, as your flow declares it: `session`, `verified_email`, `in_person`, `provider`, or `none` for a visitor.
- **Expiry.** An optional instant. An expired grant answers no.
- **A representative.** A parent, guardian or personal representative signing for the subject, with their relationship.

The typed name and the representative's name are encrypted at rest under `PITHY_FIELD_KEYS`, so run `pithy secrets provision`.

## One question

```ts
import { composedConsent } from "@pithy-sh/core/src/consent/reader";

const consent = composedConsent(capabilities, env);
await consent?.hasConsent({ kind: "account", id: userId }, "clinic.records");
```

`hasConsent` answers yes only for a grant under the current notice version, at or above the purpose's minimum, not expired, and not withdrawn since. Nothing imports this package to ask: the reader is a core seam. With no consent composed, `composedConsent` is `null`, and a capability behaves as it did before.

## Visitors

A visitor consents against an anonymous device id, held in a first-party, `HttpOnly`, `SameSite=Lax` cookie. **It is set only once they choose**: a grant or a withdrawal writes it, and reading the purposes or their own standing sets nothing. The first signed-in request that carries it merges it into the account, as one recorded row and one audit event, and the cookie is let go. A phone holds no cookie, so a signed-out app sends a visitor id of consent's own in the `x-pithy-consent-visitor` header instead: a random UUID the app mints once and keeps in its secure store, read only from a request that carries no cookie at all, and exempt from the same-origin check because nothing in such a request is ambient. It is never the device id auth registers, which operators can list and the audit trail records, so knowing a phone's device id reads and writes nothing here. A phone keeps its id after the merge, so once merged it is no visitor again, and a choice made signed out on that phone afterwards is tied to no device and cannot reach the account. The visitor's rows are never rewritten. A visitor's grant that is never merged stops counting after `visitorWindowDays`, 395 by default.

## The email gate

With consent composed, email asks before two things. A `marketing` template is sent only to a subject consenting to `email.marketing`, and opens and clicks are tracked only for one consenting to `email.tracking`. Pass the subject as `consentSubject` on the enqueue. A message with no subject is withheld if marketing and untracked either way, because nobody's consent can be shown. **Transactional mail is never gated.**

A withdrawal from `email.marketing` suppresses the address for marketing, and granting it again lifts that suppression, so the suppression list and the record never disagree. Only the withdrawal's own suppression is lifted: a bounce, a complaint, an unsubscribe link and a manual suppression all stand. A stronger suppression, such as a hard bounce, is never downgraded. The withdrawal's suppression is permanent, so it also holds mail already scheduled: a time-boxed suppression that has lapsed is replaced by it, and a live time-boxed one stronger than an unsubscribe becomes permanent rather than expiring with the withdrawal inside it. A withdrawal from `email.tracking` stops tracking on mail already queued. Without consent composed, email behaves as it always has, and `pithy doctor` says tracking runs with no consent record behind it.

## The person's own screen

`GET /consent/me` answers where the caller stands on each purpose and every choice behind it. `POST /consent/grants` and `POST /consent/withdrawals` are one request each, and both wear the same-origin gate auth publishes. Neither needs an account, so both are held to a per-IP limit first: auth's `AUTH_RATE_LIMITER` by default, counted under a `consent:` key of its own. Set `rateLimiterBinding` to hold them to a limiter of their own. `pithy ui add react --consent` scaffolds the settings screen, where a click purpose is agreed to and withdrawn on the same row. A written withdrawal is taken at the grade of its grant: a typed name, a drawn signature, or, for a grant signed through a provider, where it was signed.

The paths above are at the default `basePath`. Consent's client projection is `{ enabled, basePath }` and nothing else, declared as `ConsentClientProjection` in `src/client/projection.ts`: a Vite app reads it from `virtual:pithy/consent`, and a React Native app from its generated config, per environment. So the screens follow the base path the Worker composes: with `consent({ basePath: "/privacy" })`, the React settings screen, the React Native one and the phone's visitor header all call `/privacy`.

## Management

With `controlplane()` composed, `consent:read` (kind `reads`) reads counts of current grants and withdrawals per purpose and notice version (a person counted once, by the row `hasConsent` decides on, a visitor merged into an account counted as that account), one subject's record with the merges behind it, a signed document by its hash, and a drawn signature or certificate by its hash. There is no write: consent is the person's to give and to take back. The routes are in [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md) §13.

## A person's data

**Kept, with a basis.** When an account is purged, consent erases nothing: the record is the proof that processing was allowed while it ran and that it stopped. An export hands back every row, the merged visitors' rows and the merges, with the names opened. The drawn image is kept with the record, never purged with the account.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
