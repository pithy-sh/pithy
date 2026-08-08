---
"@pithy-sh/cli": patch
---

`pithy adopt` performs the migration `pithy doctor` only reported (#187).

Every project upgrading past #175, #179 and #182 had the same four-way sort to do by hand: the account's
Cloudflare credentials out of the root `.dev.vars` and into `<config>/cloudflare.json`, every registry
secret into `<config>/<project>/secrets.jsonc` as an envelope, a dev binding into `dev.json` under
`"vars"`, a minted `.dev.vars.<env>` into `<config>/<project>/tokens.json`, and a key nothing composes
left alone. `doctor` named each one and stopped there. This is the command that moves them.

**It never deletes from a source file.** It copies, then reports which lines now have a copy elsewhere,
and you delete them. #142 was a run that rewrote an adopter's `.dev.vars` and destroyed gitignored
secrets with no copy anywhere; a move that loses a secret has no undo. So `doctor` keeps naming those
keys until you remove them, which is the honest cost of the rule.

A dry run is the default: `pithy adopt` prints the plan and touches nothing, `pithy adopt --apply`
performs it and says so before the first write. There is no prompt — a confirmation an agent cannot
answer is a command an agent cannot run.

A value that differs from the one already at its destination is **refused, never overwritten**: two
values under one name is the state that produces "which one signed this?". A key with nowhere to go —
a project with no `name`, a `json` secret whose line is not JSON — is refused by name rather than
guessed at. Both fail the exit; a key nothing composes does not. A second run copies nothing and says so.

Every destination is written through the writer that already owns it, atomically, `0600`, in the `0700`
config directory. No value reaches stdout, `--json`, or an error message, on any path.

`pithy doctor`'s lines now name the command that performs each move, and go quiet once the values are in
their files and the source lines are gone.
