---
"@pithy-sh/cli": minor
"@pithy-sh/secrets": patch
---

`pithy secrets edit` opens the dev secrets file wherever it lives.

Since the file moved to `<config>/<project>/secrets.jsonc` it is outside every checkout — nothing to gitignore, nothing a `git add -A` reaches, nothing an `npm pack` carries. It also stopped being something you could open, and "resolve the path yourself" is not a workflow. A symlink back into the project would have fixed that and undone the move: a link is exactly what `tar`, backup software, a Docker build context and `npm pack` follow.

The command resolves the file, opens it, validates what comes back, and writes it atomically at `0600`.

**The edit is never the thing that is lost.** Your editor opens on a draft beside the real file, so the real file is only ever replaced by text that has already parsed and validated. An edit that does not parse is reported and handed straight back to you *with your text in it* — re-opening the file would silently discard everything you typed, and what you were pasting may be the only copy of that value in existence. An edit that still will not validate, that your editor abandoned, or that lost a race with a `pithy add` in the next terminal is kept in a file the error names.

**The editor is resolved in one place**: `$VISUAL`, then `$EDITOR`, then `notepad` on Windows and `nano` (else `vi`) elsewhere. A known GUI editor given no wait flag is refused by name with the flag to add — `EDITOR=code` returns the moment the window opens, so waiting on it validates a file nobody has touched yet. Without a terminal at all, the command refuses and prints the path instead of hanging on an editor CI will never close. A test fails the build if a second module ever resolves an editor for itself.

Nothing it prints or throws carries a secret value — not the notice, not the `--json` payload, not a validation error, and not the `detail` behind it. There is a test that says so.

A broken dev secrets file no longer tells you to run `pithy seed`. Every command reads that file and the seed is rarely the one that failed; the message names the file and says what is wrong with it, and leaves the command to whoever ran it.
