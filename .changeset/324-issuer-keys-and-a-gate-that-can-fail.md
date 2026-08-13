---
"@pithy-sh/core": patch
---

One unknown issuer failed a whole manifest, and the gate that should have caught it could not.

**A key is an issuer.** `SecretIssuer` degrades an unrecognised name to `other` rather than throwing, because a manifest is read from `node_modules` and can be newer than the client reading it. The rule was written once, as a helper, and its own docstring says it lives in one place "because a rule stated at four field sites is a rule three of them will eventually miss." `needs` was the fifth site. It is *keyed* by issuer, and it restated the enum bare — so a capability shipping `issuer: "vercel"` did not degrade, it failed to parse, and one name a reader did not need took the whole manifest with it: every secret of every capability in the file. The degradation is now a const both shapes read, and the key degrades exactly as the field does.

**A gate built from the fields it is checking cannot fail for the case it exists to catch.** The manifest↔registry test in auth, email and the secrets capability filtered the registry to the entries declaring both axes, then compared that to the manifest. An entry declaring *neither* axis is dropped from the expected list and is absent from the manifest, so it vanished from both sides and the comparison passed. Declaring neither is legal — `defineSecretRegistry` asks only for both or neither — and it is precisely the silent drift these declarations exist to end. The three now state the invariant instead: every registry entry appears in the manifest, and says where it comes from and how it is replaced. A fifth entry declaring nothing was planted in each; each went red naming it.

The same reading found five capabilities whose secrets say neither — payments, storage, media, turnstile and support hold Stripe, R2 and Turnstile credentials that declare no origin and no rotation, appear in no manifest, and have no gate at all. Nothing here changes that. It is now visible.
