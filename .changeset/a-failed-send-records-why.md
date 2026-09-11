---
"@pithy-sh/email": minor
---

A failed send now records why it failed.

The job's `error` column held the bare code, so a magic link that failed five times read `E_UNKNOWN` five times — while the sentence naming the cause was built one line away and thrown out with the error. It carries the provider's own words now, and a numeric provider code is recorded as itself instead of being flattened.

An authentication failure is also terminal. `E_UNKNOWN` is retryable because it means nothing named itself, and a token that cannot send as your domain is not a momentary fault — it was spending the whole attempt budget in silence.

`ClassifiedSendError` gains `detail`, the line both the row and the log read.
