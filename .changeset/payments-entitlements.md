---
"@pithy-sh/payments": minor
"@pithy-sh/core": minor
"@pithy-sh/email": minor
"@pithy-sh/storage": minor
"@pithy-sh/media": minor
"@pithy-sh/cli": minor
"@pithy-sh/i18n": minor
"@pithy-sh/ui-react": patch
---

Name your tiers and say what they buy. Declare each entitlement once — display name, numbered quotas, boolean features — and read an allowance with `quota()` without knowing which plan the caller is on. Shade any number for one customer from the control plane without taking them off their plan, with a reason on the record and a ceiling you set, or grant one subject the whole product with `unrestricted`, which keeps meaning everything as you add more. The kit counts and refuses what it already stores: emails, bytes, media. Or bill by a count your code owns — payments reports it to the store each period, or each day at its peak, and never tries to count your members for you.
