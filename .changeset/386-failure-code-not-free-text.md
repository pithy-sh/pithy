---
"@pithy-sh/secrets": patch
---

A rotation failure is recorded as a code, so no call site can write an exception's own text.

`rotationLedger.ts` has always said `error_message` holds fixed text chosen by a code and never composed
from an exception. `atRestKeyRotation.ts` composed one from `cause.message` anyway, on the master-key
rotation path — where the exceptions come from decryption, envelope decoding and config parsing, which are
the paths whose text can carry key material.

`RotationTracker.markFailure` now takes a `RotationFailureCode` and renders the sentence itself. A caller
holding an exception has nowhere to put it, which is a compile error rather than a comment asking. The
throw is still raised unchanged, and its context still travels in a `PithyError`'s `detail`, which the
HTTP codec strips.

`reencryptBatch`'s per-row catch no longer binds, and `ReencryptResult` no longer carries an `errors`
array. Nothing read it, which is why it was worth removing rather than keeping: a field waiting to be
surfaced is how a disclosure arrives in one reasonable-looking commit.

`admin/status.ts` still refuses to publish the column. That refusal is defence in depth and was never the
invariant.
