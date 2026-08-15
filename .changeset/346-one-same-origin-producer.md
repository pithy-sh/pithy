---
"@pithy-sh/payments": minor
---

One producer of the same-origin request, and a gate that fails when a second appears.

`call()` in `src/client/api.ts` knew how a browser program asks this Worker a question — the base-path default, `credentials: "include"`, and the three ways an answer can fail to be one. It was not exported, so `src/pricing/visitor.ts` wrote a second fetch that agreed with it by hand. This kit's four recurring defects are all that shape: a rule at a call site instead of at the thing being called. The second producer is the cheap one to add and the one that drifts.

It is now `callPayments`, exported, and the pricing read routes through it. `PriceVisitorFetch` is gone with the fetch it described; `PriceVisitorOptions` is an alias of `PaymentsClientOptions`, so a scaffolded screen needs no edit.

`src/client/sameOrigin.test.ts` is the gate, and neither of its permitted sets is derived from the code it polices. `fetch(` may appear only in the five rail transports named in a frozen list, each carrying the sentence that says it is an outbound call to a store's own host. `credentials: "include"` may appear in one module, named in a frozen list of one. A third list holds every browser module's imports, which is how the primitive stays free of Zod: `api.ts` imports nothing, and a specifier not written down is refused whatever it is.

A planted second producer fails both rules. The comment stripper the cookie-mode rule reads through is itself under test, because a bug in it would disarm the gate in silence.
