---
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
"@pithy-sh/cli": minor
---

Every user your seed creates now has a dev login. Press `l` in `pithy dev` and pick who to be.

`pithy seed` minted one claim. `logs/dev-login.json` held a single login, named by a per-machine `dev.json`, and `l` opened a browser as that one user. The seed creates more users than that, and every one of them is somebody you might need to be: to see what a second member sees, to check a screen that renders differently for the account that owns a row, to reproduce what a tester hit. Being any of them meant reseeding first or minting a claim by hand — slow enough that people stop doing it, so the screens only one user can reach stop getting looked at.

The artifact is now a record keyed by `userId`, with one entry per seeded auth user. The source is the seeded rows, so an adopter's own seed set yields an adopter's own users, however many that is; the canonical cast is only what `seed.includeExamples` adds to them.

`l` scales with how many there are. One identity opens straight away, exactly as before. Two to nine are numbered and one keypress picks. Ten or more get a filterable prompt, because there is no tenth digit to bind. Expiry applies per entry, so a stale claim drops one name out of the picker and leaves the rest working — where it used to be the only claim and took the feature down with it.

`pithy dev --json` gains an `identities` array: `userId`, `email` and `expiresAt` per entry, and **no claim, ever**. That is the surface a script selects against; signing in stays the browser's half.

**Minting N claims costs nothing a single claim did not.** A claim is a signature over a user id and an expiry — no extra seeded rows, a few hundred bytes each. The three properties that made one acceptable are what make many acceptable, and all three still hold: `logs/` is gitignored by the starter template, the artifact is written `0600`, and a symlink at the target is refused rather than followed.

`dev.json` keeps its job as the per-machine opt-in, and the `user` key is what carries it — not the file's existence. That file has other tenants: `pithy dev` writes bootstrap `.dev.vars` values into it, with no `user` and no interest in signing anybody in, so treating its presence as consent would mint a live claim for every seeded user on a machine where nobody asked for a dev login. With the key there, everybody gets a claim and the named user is offered first. A name this run does not seed still fails, listing the users it does.

**Nothing migrates.** The single-entry file this replaces has strings where an entry belongs, so it does not parse, and every reader already answers "no dev login" to a file that does not. The banner stays quiet until the next `pithy seed`, which is the whole plan for an artifact that is gitignored and regenerated.
