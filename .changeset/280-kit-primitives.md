---
"@pithy-sh/core": minor
"@pithy-sh/support": minor
"@pithy-sh/email": minor
"@pithy-sh/auth": patch
"@pithy-sh/testers": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/cli": patch
---

Semver and address normalization are primitives now, and the kit uses them.

The kit exported neither, so the first adopter wrote both. Taken up before publication, when it costs one commit rather than a deprecation.

`@pithy-sh/core/src/semver/semver` is semver §11.4, once: `parseSemver`, `formatSemver`, `compareSemver`, `semverGap`. The four rules that decide a release feed's order are each one line to get wrong quietly — numeric identifiers compare numerically and alphanumerics lexically, a numeric identifier ranks *below* an alphanumeric one, a longer identifier set wins when every shared one is equal, and a stable outranks every prerelease of the same core. Numeric identifiers are compared as digit strings, not through `Number`, because above 2^53 two distinct identifiers round to the same float and `latest` becomes whatever order the rows arrived in.

The CLI's update notifier uses it and stays narrow: `parseVersion` still drops the prerelease, so nobody on the stable channel is nagged about an `rc.1`. Its tests pass unmodified. It now refuses a handful of strings it used to coerce — `1.2.` was `1.2.0` and `01.2.3` was `1.2.3` — none of which a registry ever returns.

`@pithy-sh/core/src/address/address` is the one rule for whether two strings are the same person. It trims and lowercases both halves, and it deliberately does **not** collapse subaddressing or dots, unicode-normalize, convert IDN, or validate — the boundary is written down in `docs/CONVENTIONS.md`, because a normalizer that quietly merges two people is worse than none. `parseAddress` sits beside it for mail headers: unwrap `Ada Lovelace <ada@example.com>`, bound it, refuse anything that is not one address, return it normalized.

Five capabilities compared addresses with five copies of `trim().toLowerCase()`, and a disagreement between them presents as "the suppression list did not work" rather than as anything about addresses. `auth`, `email`, `support`, `testers` and `matchmaking` now route through the primitive. `support`'s `normalizeAddress` and `email`'s `normalizeEmail` are gone; use core's `parseAddress` and `normalizeAddress`.
