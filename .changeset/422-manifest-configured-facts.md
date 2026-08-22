---
"@pithy-sh/core": minor
"@pithy-sh/payments": minor
---

The manifest says what a project bills, so a management client can write a grant.

A route says where to call and which scope to hold. It never said what to **send**. `POST {base}/entitlements/grant` names the holder and never assumes it, and whether a project's holders are people or organizations is `PaymentsConfig.billingSubject` — required, with no default. A client could not read it, so it could only guess, and against a project billing the other kind the guess is refused. The dashboard's Users record refuses both entitlement acts for exactly that reason, and no scope and no plan opened it.

A capability now states **configured facts** on its own manifest entry: `configKeys` is the closed vocabulary, `config` is what this deployment resolved each one to. Read them with `namedConfigValues(entry)` from `@pithy-sh/core`, which drops a fact nothing declares — so a client of an older build renders what it knows and nothing for the rest. Payments states one, `billingSubject`, with its choices read off `PaymentsSubjectType`.

A fact is not a health number, and the two are easy to confuse because they sit side by side. A number is per caller, is produced, may be `unavailable`, and is rendered. A fact is the same for every caller, is read off resolved config at assembly, cannot fail, and is **respected** — it goes into the next request rather than onto a rail. `defineManifestConfig` is the only constructor: scalars only, a value nothing declares is refused, and a value outside its own `choices` never gets built, so a capability cannot put its provider credentials on a discovery read. A fact whose values are not enumerable writes `choices: null`; an empty list is refused at the declaration, because nothing could satisfy it and the refusal would name no permitted value at all.

Both fields are defaulted rather than required. A Worker deployed before them sends neither, and its manifest still parses whole.
