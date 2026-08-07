---
"@pithy-sh/cli": patch
---

An atomic write follows a symlink only when we could have made it, and reclaims what a killed run leaves.

Making the temp file unguessable moved the exfiltration one step earlier instead of closing it. Plant a
symlink at `.dev.vars` rather than at its temp file and `writeFileAtomic` followed it, adopted the
destination's mode, and renamed onto it. Reproduced against the real CLI: `pithy add secrets` minted
`SECRETS_ENCRYPTION_KEYS` straight into a directory outside the project and printed `Done.`

Containment cannot be by location. `apps/<worker>/.dev.vars` links to the project's shared file and a
worktree's links to the **main checkout's**, outside the tree entirely — the same shape as the attack and
the opposite answer, so refusing by destination would put #146 back. It is by **owner**: `symlink(2)`
stamps the creating uid on the link and only root may change it, so a link made by the developer running
the command is distinguishable from one planted by whoever else can write the directory. Every component
of the path is walked, not only the last — a link three directories up carries a write out of the project
just as completely.

The random temp name also leaked. Every interrupted run left a distinct `.dev.vars.<rand>.tmp` holding the
whole plaintext credential file, where the old fixed name was at least overwritten by the next run. A
finished write now sweeps its target's stale siblings — its own name shape, regular files, ours, and older
than a minute.
