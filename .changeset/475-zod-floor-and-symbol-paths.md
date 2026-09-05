---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/i18n": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
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

`pithy ui add` no longer crashes on the manifest `pithy init` wrote.

It crashed for any adopter whose resolver landed below zod 4.4.0, and for nobody else — the second command of the standard first run, on a file the first command had just written. Below that version `z.record`'s key check enumerates symbol keys, and comment-json hangs a document's comments off exactly those, so a manifest was refused for having comments in it. Bisected: 4.0.0 through 4.3.6 fail, 4.4.0 onward pass.

**The defect was the range, not the code.** Every package declared `zod: ^4.0.0` while depending on behavior that arrives in 4.4.0 — a promise about every version in the range that only some of them keep. The floor is now `^4.4.0`, and `manifests.test.ts` holds it there with the reason attached.

Nothing loosens `z.record`'s key check. Symbols are preserved deliberately so an adopter's comments round-trip (#222), and the schema already validates by delegation to keep that true.

The reporter is fixed too, separately. `whereItBroke` joined an issue path with `Array.prototype.join`, which throws on a symbol — so it threw while reporting, and the adopter got a `TypeError` from an unrelated file instead of a word about theirs. It stringifies each segment now. Nothing in the kit produces such a path any more; a function whose job is to name where something broke still must not be able to break.
