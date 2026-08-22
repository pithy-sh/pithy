---
"@pithy-sh/email": minor
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/ui-react": patch
"@pithy-sh/vector": patch
"@pithy-sh/vite": patch
---

The kit writes American English, and an email job is `canceled`.

**One line here is a break, and it is the `@pithy-sh/email` job status.** `EmailJobStatus` spelled its final state `cancelled`; it is `canceled` now. That string is not internal — it is a column value in `pithy_email_jobs`, the `status` field of every job the control-plane routes return, the `?status=` filter on `GET /email/jobs`, and the `status` of the `SendOutcome` a send resolves to. **If your code compares `status === "cancelled"`, or filters a job listing on it, that comparison is now always false and you must update it.** Nothing warns you: it is a string against a string, so it fails quietly by matching nothing rather than by throwing. Grep your repository for the seven-letter spelling before you take this minor.

**There is no migration, and that is a fact about this moment rather than a shortcut.** `0001_init.ts` declares the column as `.addColumn("status", "text", (c) => c.notNull())` — bare text, no CHECK, no enum — so the value set lives only in Zod and the database has nothing to alter. And no database anywhere holds a row spelling it the old way: every package is `0.0.0`, `npm view @pithy-sh/email version` still 404s, and `0001_init` *is* the schema under CONTRIBUTING.md's pre-publish rule. Both halves were re-checked before the value moved. **Once a version is cut this inverts** — a status value that has been written somewhere real is history, and changing it then costs a migration plus a compatibility window for the rows already carrying it.

**The two capabilities stopped spelling one concept two ways, and they got there from opposite directions.** `@pithy-sh/payments` already had `canceled` in `PurchaseStatus`, and it keeps it because it is *Paddle's* wire value — rewriting a vendor's own string would be inventing a translation layer over somebody else's API. `@pithy-sh/email`'s was the kit's own vocabulary: nobody else names those states, so the spelling was ours to pick and we picked the one the rest of the prose uses. Two arguments, one spelling. The reason is written above the enum in `email/src/data/enums.ts` so the next reader finds the decision instead of re-deriving it.

**Every other package here changes prose only, and no runtime behavior moves in any of them.** Comments, doc comments, test names, Zod `.describe()` text, `docs/`, each package's own `README.md` and `docs/`, and the `templates/` starter that `pithy init` vendors — en-GB spellings became en-US throughout. The package READMEs matter more than their line count suggests: sixteen of the eighteen manifests declare no `files`, so a README ships in the tarball and is the most-read prose here. Bytes do move in these tarballs, because `src` packs whole and a `.describe()` string is runtime data an adopter can read; nothing an import reaches behaves differently. Twenty of the twenty-one packages carried at least one. `@pithy-sh/multiplayer` carried none and takes no bump.

**A sweep like this is mostly a list of words it must not touch, and that list is the work.** Several near-neighbors are already correct American English and were left alone: `cancellation`, `fulfilled` / `fulfilling` / `fulfillment`, and `enrolled` / `enrolling` all keep their spelling, and only the exact words `fulfil` and `enrol` moved. `programme` was read one instance at a time rather than replaced, because it is right in both dialects when it means a broadcast and wrong when it means a scheme. Two third-party wire values that look exactly like the thing being fixed stay as they are: Lemon Squeezy sends `cancelled` and `payments/src/rails/lemonSqueezy/objects.ts` still maps `case "cancelled": return "canceled";`, which is the boundary doing its job, and Cloudflare's own build outcome in `@pithy-sh/cloudflare` is `cancelled` because that is what the API returns.

**A census keeps it true.** The rule is *the words this project writes are American*, and it is now a test over committed source rather than a thing whoever greps next has to remember. It was watched failing on a planted spelling before it was trusted, and it is proven not to flag a wire value, a generated vendor notice, or a quoted third-party string — by planting one of each. The exceptions are named with their reasons beside them, which is the part a word list alone could never carry.
