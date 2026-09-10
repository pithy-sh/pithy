---
"@pithy-sh/core": patch
"@pithy-sh/secrets": patch
"@pithy-sh/payments": patch
"@pithy-sh/auth": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/media": patch
"@pithy-sh/storage": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/cli": patch
---

`pithy secrets create` asks a `json` secret one field at a time, instead of one blind blob.

It prompted once, masked, for a whole JSON document — brackets and all, unseen, with no feedback until the last character and then `Secret 'payments-provider-credentials' is not valid JSON.` It landed hardest on the credentials nothing can mint: a payment rail's keys, an OAuth client secret, taken by a human from somebody else's console and entered once.

On a terminal the registry entry's schema is now walked and each field asked for on its own, using that field's own `.describe()` as the question. Every field is masked, with no exceptions — these values arrive by paste, so masking costs an operator nothing they were going to use. What the answers assemble into goes through `validateSecretValue` like any other value: one parse gate, unmoved.

Which blocks of a bundle get asked for is the capability's answer, not the CLI's guess. `PaymentsProviderCredentials` is five optional rail blocks and only `pithy.config.ts` knows which two are on, so `payments()` states it on the new `Capability.secretBranches` seam and the CLI reads it. One configured rail is named and asked for; several become a checkbox of exactly those; a rail that is off is never offered and never written. The keys happen to match the toggles one-for-one today, and matching them by name would have been right by luck.

Piped input is untouched: one whole JSON document, byte for byte, because that is what CI and agents send. A schema the walk cannot render falls back to the single prompt — refusing to ask is fine, guessing a shape is not.

Three things a per-field prompt has to get right, and it now does. **A field is asked for on its own line only once somebody has said it fits on one.** A masked prompt truncates a longer paste to a single line — the first if your terminal sends carriage returns, the last if it sends newlines, both measured against the real prompt under a real pty — and the surviving fragment satisfies `z.string().min(1)`, so the corrupt bundle passes validation and surfaces as a signature that never verifies. So every string field of every `json` secret now declares itself, `.meta({ multiline: true })` or `.meta({ multiline: false })`, and a repo-wide test fails any field in the kit that has not. Apple's and Google's private keys say they span lines; a secret with one among the blocks you configured is asked for as a single JSON document instead. **A field that has said nothing is treated exactly the same way** — in your own registry that is what keeps a value nobody classified out of a single-line prompt. A field marked single-line and handed a PEM anyway is refused at the prompt, by name. **An update says what it replaces every time**, not only when a checkbox renders: the value is sealed under a master key the CLI cannot read, so a block for a rail you switched off is dropped by the write — and the project down to one rail, which gets no checkbox, was the case that most needed telling. **And a failed field is named where an operator can read it** — on the problem line, not in `detail`, which reaches no surface at all.

**`pithy secrets` asks two questions about your terminal, and keeps them apart.** *Is a document being piped to me* is stdin's answer and nobody else's — a pipe, a heredoc, a file, with `--json` or without, into a terminal or into a file, all read the same document the same way. *May a prompt be drawn* is stdout's and `--json`'s. One boolean for both is how a multiselect ended up behind a check on stdin alone, and how the first fix for that turned `--json` on a terminal, and any run with output redirected to a file, into a silent unmasked read of the operator's terminal for a credential. Both questions are now named separately, and the case with neither a document nor a way to ask refuses and says how to pipe one, rather than reading the terminal or waiting forever.

`pithy doctor` also names a command that runs, once. A `cf-secrets-store` secret nothing can mint gets a `pithy secrets create` line, and for a **`global`** one that line no longer carries `--env` — a value identical in every environment cannot be narrowed to one, so `pithy secrets create <name> --env prod` was refused by the rule and the adopter got a second complaint instead of a value. That line is now printed **once for the Worker** rather than once per environment: it named every stanza short of the secret in three identical sentences, and an adopter following them in order could run exactly one before `Secret 'X' already exists.` And `pithy secrets provision` is named only for what it actually creates — the values the kit composes and the master key. A `bootstrap` secret of your own is read from its binding and composed by no step, so it gets the `create` line rather than a command that would create nothing for it (#517).
