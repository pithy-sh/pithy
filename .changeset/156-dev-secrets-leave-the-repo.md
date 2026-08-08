---
"@pithy-sh/cli": patch
"@pithy-sh/secrets": patch
---

Dev secrets leave the repository. They live at `<config>/<project>/secrets.jsonc`.

`.dev.vars` sits in the worker's directory because wrangler reads it there — the location is not ours
to choose. Nothing but our own CLI reads the secrets file, and the CLI resolves its own paths. So it
does not need to be in the project; it needs to be found.

Everything that followed from having it there followed from that one assumption. A mint into a file the
project did not ignore. A `.tmp` sibling one SIGINT from a published tarball. A worktree with no secrets
at all, which then minted a second set and diverged in silence. An `rm -rf` on a checkout taking every
dev credential with it. Each was patched where it appeared; moving the file removes the class.

No symlink either. A link puts the file back in the field of view of every tool that follows one.

`<config>` is `$PITHY_CONFIG_DIR`, else `%APPDATA%\pithy`, `$XDG_CONFIG_HOME/pithy`, or
`~/.config/pithy` — the directory `~/.config/pithy/<project>/dev.json` already lives in, resolved by the
resolver that already existed. The override is required rather than convenient: CI has no home directory
worth writing to, and without it every test scaffolding one project name writes to one real file.

The directory is `0700` and the file `0600`, held there on every write rather than only on creation.

What goes with it: the gitignore guarantee for the secrets file, because there is nothing in the
repository to ignore — `.dev.vars` keeps its lines, and `.dev.secrets.example.jsonc` stays, committed,
as documentation. The worktree link, because every worktree of a project resolves the same path with no
wiring. Every refusal a write could return, because there is nothing left to refuse.

Because the file is no longer in your file tree, `pithy doctor` prints its resolved path on every run,
and every error naming it names it absolutely. The path is keyed on your project's `name`, so a rename
leaves the old directory behind with your values in it — doctor names that too rather than leaving you a
mystery.

Delete the whole checkout and re-clone: the secrets are still there.
