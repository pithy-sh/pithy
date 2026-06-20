---
"@pithy-sh/email": minor
---

Expose a bound `enqueue` seam on the email capability. A consumer (e.g. `@pithy-sh/auth`) delivers mail by passing its worker env and the high-level input; the capability owns the `DB`/`EMAIL_SENDER` bindings, the from-identity, and the theme — no capability assembles the email infrastructure itself.
